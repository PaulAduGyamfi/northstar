import type { NudgeCandidate } from "@northstar/domain";
import { GmailError, type MessageHeaders, type ReplyHeaders } from "@northstar/inbox";
import { describe, expect, it } from "vitest";
import {
  type BuiltNudge,
  MAX_NUDGE,
  type NudgeDeps,
  type NudgeLetterReason,
  runNudges,
} from "./nudge.js";

// Follow-up nudges in `funnel inbox` (NS-281 slice 2) with every port faked: no Gmail, Gate or
// database. Invented ids and example.com addresses only.

const NOW = new Date("2026-11-28T12:00:00Z");
const ID = (n: number) => `18c3f0a2b4d6e8${String(n).padStart(2, "0")}`;
const APP = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const DAY = 86_400_000;

// An application in the applied stage, its newest verified message a confirmation `days` ago.
const candidate = (n: number, days = 10, over: Partial<NudgeCandidate> = {}): NudgeCandidate => ({
  applicationId: APP(n),
  status: "submitted",
  lastMoveAt: new Date(NOW.getTime() - days * DAY),
  lastMail: {
    gmailMessageId: ID(n),
    threadId: ID(n),
    receivedAt: new Date(NOW.getTime() - days * DAY),
    kind: "confirmation",
  },
  replyFiled: false,
  ...over,
});

const headers = (id: string, at: string, labelIds?: string[]): MessageHeaders => ({
  id,
  threadId: id,
  from: "Acme Hiring <jobs@acme.example>",
  senderDomain: "acme.example",
  subject: "Thanks for applying",
  deliveredTo: null,
  authenticationResults: null,
  receivedAt: new Date(at),
  ...(labelIds ? { labelIds } : {}),
});

const INBOUND: ReplyHeaders = {
  from: "Jo Hiring <jo@acme.example>",
  replyTo: null,
  subject: "Thanks for applying",
  messageId: "<thanks1@acme.example>",
  references: null,
};

function fake(over: Partial<NudgeDeps> = {}) {
  const filed: unknown[] = [];
  const letters: { id: string; reason: NudgeLetterReason; key: string }[] = [];
  const built: { id: string; stage: string }[] = [];
  let read = 0;
  const deps: NudgeDeps = {
    enabled: true,
    now: () => NOW,
    nudgeLetters: async () => [],
    candidates: async () => {
      read++;
      return [candidate(1)];
    },
    threadMessageIds: async (threadId) => [{ id: threadId }],
    getHeaders: async (id) => headers(id, "2026-11-18T09:00:00Z"),
    getReplyHeaders: async () => INBOUND,
    build: (input): BuiltNudge => {
      built.push({ id: input.gmailMessageId, stage: input.stage });
      return { ok: true, value: { gmailMessageId: input.gmailMessageId } };
    },
    file: async (nudge) => {
      filed.push(nudge);
      return { ok: true };
    },
    recordNudgeLetter: async (d, reason, key) => {
      letters.push({ id: d.gmailMessageId, reason, key });
    },
    ...over,
  };
  return { deps, filed, letters, built, read: () => read };
}

describe("runNudges", () => {
  it("reads, builds and files nothing while it is off", async () => {
    const f = fake({ enabled: false });
    const r = await runNudges(f.deps);
    expect([r, f.read(), f.filed]).toEqual([
      {
        enabled: false,
        filed: 0,
        answered: 0,
        nudgeLetters: 0,
        nudgeStoppedBy: null,
        moreToNudge: false,
      },
      0,
      [],
    ]);
  });

  it("files one nudge per application due, built with its stage, and none for one not due", async () => {
    const f = fake({
      candidates: async () => [
        candidate(1, 10),
        candidate(2, 6, { status: "in_process" }),
        // Applied 3 days ago: not due yet.
        candidate(3, 3),
      ],
    });
    const r = await runNudges(f.deps);
    expect([r.filed, f.built, f.filed.length]).toEqual([
      2,
      [
        { id: ID(1), stage: "applied" },
        { id: ID(2), stage: "interview" },
      ],
      2,
    ]);
  });

  it("files nothing on a second run once the first run's nudge is filed", async () => {
    const first = fake({ candidates: async () => [candidate(1)] });
    const second = fake({ candidates: async () => [candidate(1, 10, { replyFiled: true })] });
    const a = await runNudges(first.deps);
    const b = await runNudges(second.deps);
    expect([a.filed, b.filed, second.built]).toEqual([1, 0, []]);
  });

  it("files nothing when Paul already followed up himself in the thread", async () => {
    const f = fake({
      threadMessageIds: async () => [{ id: ID(1) }, { id: "18c3f0a2b4d6e899" }],
      getHeaders: async (id) =>
        id === ID(1)
          ? headers(id, "2026-11-18T09:00:00Z")
          : headers(id, "2026-11-20T09:00:00Z", ["SENT"]),
    });
    const r = await runNudges(f.deps);
    expect([r.answered, r.filed, f.filed]).toEqual([1, 0, []]);
  });

  it("letters a no-reply sender, bad headers, a refused filing and an unreadable message, by reason", async () => {
    const f = fake({
      candidates: async () => [
        candidate(1, 13),
        candidate(2, 12),
        candidate(3, 11),
        candidate(4, 10),
      ],
      getReplyHeaders: async (id) => {
        if (id === ID(4)) throw new GmailError("gmail answered 404", 404);
        return INBOUND;
      },
      build: (input): BuiltNudge => {
        if (input.gmailMessageId === ID(1)) return { ok: false, error: { kind: "NoReplyAddress" } };
        if (input.gmailMessageId === ID(2)) return { ok: false, error: { kind: "InvalidReply" } };
        return { ok: true, value: input.gmailMessageId };
      },
      file: async () => ({ ok: false }),
    });
    const r = await runNudges(f.deps);
    expect([f.letters, r.nudgeLetters, r.filed]).toEqual([
      [
        { id: ID(1), reason: "no_reply_address", key: `mail.nudge:${ID(1)}:1` },
        { id: ID(2), reason: "invalid_headers", key: `mail.nudge:${ID(2)}:1` },
        { id: ID(3), reason: "file_refused", key: `mail.nudge:${ID(3)}:1` },
        { id: ID(4), reason: "read_failed", key: `mail.nudge:${ID(4)}:1` },
      ],
      4,
      0,
    ]);
  });

  it("stops, with no letter, when Gmail doesn't answer, and says more are waiting", async () => {
    const f = fake({
      candidates: async () => [candidate(1, 11), candidate(2, 10)],
      getReplyHeaders: async () => {
        throw new GmailError("gmail answered 503", 503);
      },
    });
    const r = await runNudges(f.deps);
    expect([r.nudgeStoppedBy, f.letters, r.moreToNudge]).toEqual(["GmailError", [], true]);
  });

  it("passes over a lettered application until Paul retries it, then gives its letter a new key", async () => {
    const f = fake({
      candidates: async () => [candidate(1, 11), candidate(2, 10)],
      nudgeLetters: async () => [
        { idempotencyKey: `mail.nudge:${ID(1)}:1`, action: null },
        { idempotencyKey: `mail.nudge:${ID(2)}:1`, action: "retry" },
      ],
      file: async () => ({ ok: false }),
    });
    const r = await runNudges(f.deps);
    expect([f.built.map((b) => b.id), f.letters.map((l) => l.key), r.moreToNudge]).toEqual([
      [ID(2)],
      [`mail.nudge:${ID(2)}:2`],
      false,
    ]);
  });

  it("files at most the cap a run and says more are waiting", async () => {
    const many = Array.from({ length: MAX_NUDGE + 2 }, (_, i) => candidate(i + 1, 20 - i));
    const f = fake({ candidates: async () => many });
    const r = await runNudges(f.deps);
    expect([r.filed, r.moreToNudge]).toEqual([MAX_NUDGE, true]);
  });
});
