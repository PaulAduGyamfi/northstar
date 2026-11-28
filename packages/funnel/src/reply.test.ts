import type { ReplyCandidate } from "@northstar/db";
import { GmailError, type MessageHeaders, type ReplyHeaders } from "@northstar/inbox";
import { describe, expect, it } from "vitest";
import type { LetterRow } from "./inbox.js";
import {
  type BuiltReply,
  MAX_REPLY,
  type ReplyDeps,
  type ReplyLetter,
  type ReplyLetterReason,
  runReplies,
} from "./reply.js";

// Reply drafts by grade in `funnel inbox` (NS-238 item 2's caller) with every port faked: no
// Gmail, Gate or database. Invented Gmail ids and example.com addresses only.

const NOW = new Date("2026-11-28T12:00:00Z");
const ID = (n: number) => `18c3f0a2b4d6e8${String(n).padStart(2, "0")}`;
const candidate = (n: number, grade = "B"): ReplyCandidate => ({
  mailLinkId: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`,
  gmailMessageId: ID(n),
  threadId: ID(n),
  grade,
});

const headers = (id: string, at: string, labelIds?: string[]): MessageHeaders => ({
  id,
  threadId: id,
  from: "Jo Recruiter <jo@globex.example>",
  senderDomain: "globex.example",
  subject: "A role at Globex",
  deliveredTo: null,
  authenticationResults: null,
  receivedAt: new Date(at),
  ...(labelIds ? { labelIds } : {}),
});

const INBOUND: ReplyHeaders = {
  from: "Jo Recruiter <jo@globex.example>",
  replyTo: null,
  subject: "A role at Globex",
  messageId: "<role1@globex.example>",
  references: null,
};

function fake(over: Partial<ReplyDeps> = {}) {
  const filed: unknown[] = [];
  const letters: { id: string; reason: ReplyLetterReason; key: string }[] = [];
  const built: { id: string; grade: ReplyLetter }[] = [];
  const asked: { since: Date; limit: number }[] = [];
  const deps: ReplyDeps = {
    enabled: true,
    now: () => NOW,
    replyLetters: async () => [],
    candidates: async (since, limit) => {
      asked.push({ since, limit });
      return [candidate(1)];
    },
    // Each message alone in its own thread unless a test says otherwise.
    threadMessageIds: async (threadId) => [{ id: threadId }],
    getHeaders: async (id) => headers(id, "2026-11-27T09:00:00Z"),
    getReplyHeaders: async () => INBOUND,
    build: (input): BuiltReply => {
      built.push({ id: input.gmailMessageId, grade: input.grade });
      return { ok: true, value: { gmailMessageId: input.gmailMessageId } };
    },
    file: async (reply) => {
      filed.push(reply);
      return { ok: true };
    },
    recordReplyLetter: async (m, reason, key) => {
      letters.push({ id: m.gmailMessageId, reason, key });
    },
    ...over,
  };
  return { deps, filed, letters, built, asked };
}

describe("runReplies", () => {
  it("reads, builds and files nothing while it is off", async () => {
    const f = fake({ enabled: false });
    const r = await runReplies(f.deps);
    expect([r, f.asked, f.filed]).toEqual([
      {
        enabled: false,
        filed: 0,
        answered: 0,
        archiveSuggested: 0,
        replyLetters: 0,
        replyStoppedBy: null,
        moreToReply: false,
      },
      [],
      [],
    ]);
  });

  it("files one reply per graded email, built with the email's own letter", async () => {
    const f = fake({ candidates: async () => [candidate(1, "A"), candidate(2, "D")] });
    const r = await runReplies(f.deps);
    expect([r.filed, f.built, f.filed]).toEqual([
      2,
      [
        { id: ID(1), grade: "A" },
        { id: ID(2), grade: "D" },
      ],
      [{ gmailMessageId: ID(1) }, { gmailMessageId: ID(2) }],
    ]);
  });

  it("asks only for mail received in the last 14 days", async () => {
    const f = fake();
    await runReplies(f.deps);
    expect(f.asked[0]?.since).toEqual(new Date("2026-11-14T12:00:00Z"));
  });

  it("files nothing for an email Paul answered later in the same thread", async () => {
    const f = fake({
      threadMessageIds: async () => [{ id: ID(1) }, { id: ID(9) }],
      getHeaders: async (id) =>
        id === ID(9)
          ? headers(id, "2026-11-27T10:00:00Z", ["SENT"])
          : headers(id, "2026-11-27T09:00:00Z"),
    });
    const r = await runReplies(f.deps);
    expect([r.filed, r.answered, f.filed]).toEqual([0, 1, []]);
  });

  it("still files when Paul's sent message in the thread came before the email", async () => {
    const f = fake({
      threadMessageIds: async () => [{ id: ID(9) }, { id: ID(1) }],
      getHeaders: async (id) =>
        id === ID(9)
          ? headers(id, "2026-11-26T10:00:00Z", ["SENT"])
          : headers(id, "2026-11-27T09:00:00Z"),
    });
    expect((await runReplies(f.deps)).filed).toBe(1);
  });

  it("doesn't count an unsent draft in the thread as an answer", async () => {
    const f = fake({
      threadMessageIds: async () => [{ id: ID(1) }, { id: ID(9) }],
      getHeaders: async (id) =>
        id === ID(9)
          ? headers(id, "2026-11-27T10:00:00Z", ["DRAFT"])
          : headers(id, "2026-11-27T09:00:00Z"),
    });
    expect((await runReplies(f.deps)).filed).toBe(1);
  });

  it("gives each refusal its own letter, keyed per message, and files nothing for it", async () => {
    const kinds = {
      [ID(1)]: "InvalidReply",
      [ID(2)]: "NoReplyAddress",
    } as const;
    const f = fake({
      candidates: async () => [candidate(1), candidate(2), candidate(3)],
      build: (input) => {
        const kind = kinds[input.gmailMessageId as keyof typeof kinds];
        return kind ? { ok: false, error: { kind } } : { ok: true, value: {} };
      },
      file: async () => ({ ok: false }),
    });
    const r = await runReplies(f.deps);
    expect([r.filed, r.replyLetters, f.letters]).toEqual([
      0,
      3,
      [
        { id: ID(1), reason: "invalid_headers", key: `mail.reply:${ID(1)}:1` },
        { id: ID(2), reason: "no_reply_address", key: `mail.reply:${ID(2)}:1` },
        { id: ID(3), reason: "file_refused", key: `mail.reply:${ID(3)}:1` },
      ],
    ]);
  });

  it("counts an F as archive suggested, with no letter and nothing filed", async () => {
    const f = fake({ build: () => ({ ok: false, error: { kind: "ArchiveSuggested" } }) });
    const r = await runReplies(f.deps);
    expect([r.archiveSuggested, r.replyLetters, f.filed]).toEqual([1, 0, []]);
  });

  it("passes over an email with an open letter, and tries one Paul retried again", async () => {
    const rows: LetterRow[] = [
      { idempotencyKey: `mail.reply:${ID(1)}:1`, action: null },
      { idempotencyKey: `mail.reply:${ID(2)}:1`, action: "retry" },
    ];
    const f = fake({
      replyLetters: async () => rows,
      candidates: async () => [candidate(1), candidate(2)],
      file: async () => ({ ok: false }),
    });
    await runReplies(f.deps);
    expect(f.letters).toEqual([
      { id: ID(2), reason: "file_refused", key: `mail.reply:${ID(2)}:2` },
    ]);
  });

  it("stops with no letter when Gmail doesn't answer", async () => {
    const f = fake({
      candidates: async () => [candidate(1), candidate(2)],
      getReplyHeaders: async () => {
        throw new GmailError("Gmail answered 503 after 5 retries", 503);
      },
    });
    const r = await runReplies(f.deps);
    expect([r.replyStoppedBy, r.replyLetters, r.moreToReply]).toEqual(["GmailError", 0, true]);
  });

  it("letters an email Gmail can't find (404) and goes on to the next", async () => {
    const f = fake({
      candidates: async () => [candidate(1), candidate(2)],
      getReplyHeaders: async (id) => {
        if (id === ID(1)) throw new GmailError("Gmail answered 404", 404);
        return INBOUND;
      },
    });
    const r = await runReplies(f.deps);
    expect([r.filed, f.letters.map((l) => l.reason)]).toEqual([1, ["read_failed"]]);
  });

  it("letters a stored letter it doesn't know instead of building a reply", async () => {
    const f = fake({ candidates: async () => [candidate(1, "Z")] });
    const r = await runReplies(f.deps);
    expect([r.filed, f.built, f.letters.map((l) => l.reason)]).toEqual([
      0,
      [],
      ["invalid_headers"],
    ]);
  });

  it("files at most MAX_REPLY a run and says more are waiting", async () => {
    const many = Array.from({ length: MAX_REPLY + 2 }, (_, i) => candidate(i + 1));
    const f = fake({ candidates: async () => many });
    const r = await runReplies(f.deps);
    expect([r.filed, r.moreToReply]).toEqual([MAX_REPLY, true]);
  });
});
