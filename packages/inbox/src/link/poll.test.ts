import { describe, expect, it } from "vitest";
import type { MessageHeaders } from "../gmail.js";
import {
  MAX_PER_POLL,
  type MailPollDeps,
  newMailQuery,
  POLL_OVERLAP_MS,
  pollNewMail,
} from "./poll.js";
import type { CandidateRow } from "./step.js";

// The mail poller (NS-247) on a fake Gmail client and fake step deps. Synthetic mail only.

const MAILBOX = "candidate@example.com";
const SINCE = new Date("2026-11-25T12:00:00Z");
const APP = "00000000-0000-4000-8000-0000000000a1";
const minutes = (n: number) => new Date(SINCE.getTime() + n * 60_000);

// A received message n minutes after SINCE. Tagged by default; `kind` picks what it looks like.
function message(n: number, kind: "tagged" | "job" | "other" | "unknown_tag" = "tagged") {
  const base: MessageHeaders = {
    id: `m${n}`,
    threadId: `t${n}`,
    from: "Globex Recruiting <talent@globex.example>",
    senderDomain: "globex.example",
    subject: "Lunch on Friday?",
    deliveredTo: "candidate+ns-k3q2m7@example.com",
    authenticationResults: null,
    receivedAt: minutes(n),
    labelIds: ["INBOX"],
  };
  if (kind === "job") return { ...base, deliveredTo: MAILBOX, subject: "Thank you for applying" };
  if (kind === "other") return { ...base, deliveredTo: MAILBOX };
  if (kind === "unknown_tag") return { ...base, deliveredTo: "candidate+ns-zzzzzz@example.com" };
  return base;
}

function fakeDeps(messages: MessageHeaders[], over: Partial<MailPollDeps> = {}) {
  const queries: string[] = [];
  const headerReads: string[] = [];
  const recorded: string[] = [];
  const deps: MailPollDeps = {
    mailbox: MAILBOX,
    // The run starts well after every synthetic message.
    now: () => minutes(10_000),
    knownDomains: new Set(),
    gmail: {
      // Gmail lists newest first.
      listIds: async (q) => {
        queries.push(q);
        // Like Gmail: only mail received after the query's `after:` second.
        const after = Number(q.match(/after:(\d+)/)?.[1] ?? 0) * 1000;
        return [...messages]
          .filter((m) => m.receivedAt.getTime() > after)
          .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
          .map((m) => ({ id: m.id, threadId: m.threadId }));
      },
      getHeaders: async (id) => {
        headerReads.push(id);
        const m = messages.find((x) => x.id === id);
        if (!m) throw new Error("missing");
        return m;
      },
    },
    openWindows: async () => [],
    readTags: async () => [{ tag: "k3q2m7", applicationId: APP, tenantKey: null }],
    readCandidates: async (): Promise<CandidateRow[]> => [
      { applicationId: APP, createdAt: new Date("2026-11-01T00:00:00Z"), ats: ["greenhouse"] },
    ],
    readLinkedThreads: async () => new Map(),
    record: async (input) => {
      if (recorded.includes(input.message.id)) return { recorded: false };
      recorded.push(input.message.id);
      return { recorded: true };
    },
    ...over,
  };
  return { deps, queries, headerReads, recorded };
}

describe("newMailQuery", () => {
  it("asks for received mail after since, less the overlap, leaving out sent, drafts, spam, trash and chats", () => {
    const after = Math.floor((SINCE.getTime() - POLL_OVERLAP_MS) / 1000);
    expect(newMailQuery(SINCE)).toBe(
      `after:${after} -in:sent -in:drafts -in:spam -in:trash -in:chats`,
    );
  });
});

describe("pollNewMail", () => {
  it("hands job mail and mail to known tags to the step, oldest first, and counts the rest", async () => {
    const { deps, headerReads, recorded } = fakeDeps([
      message(3, "other"),
      message(1, "tagged"),
      message(2, "job"),
      message(4, "unknown_tag"),
    ]);
    const report = await pollNewMail(deps, { since: SINCE });
    expect([headerReads, recorded]).toEqual([
      ["m1", "m2", "m3", "m4"],
      ["m1", "m2"],
    ]);
    expect(report).toEqual({
      listed: 4,
      handled: 4,
      linked: 1,
      queued: 1,
      skipped: 0,
      notJobMail: 2,
      passedOver: 0,
      truncated: false,
      nextSince: minutes(4),
      nextOverlap: true,
      stoppedBy: null,
      stoppedAt: null,
    });
  });

  it("records nothing twice when the same window is polled again", async () => {
    const { deps, recorded } = fakeDeps([message(1), message(2, "job")]);
    const first = await pollNewMail(deps, { since: SINCE });
    const again = await pollNewMail(deps, { since: first.nextSince });
    expect([recorded, again.linked + again.queued, again.handled]).toEqual([["m1", "m2"], 2, 2]);
  });

  it("handles the oldest batch and says so when more mail was listed than one run takes", async () => {
    const many = Array.from({ length: MAX_PER_POLL + 5 }, (_, i) => message(i + 1));
    const { deps, headerReads } = fakeDeps(many);
    const report = await pollNewMail(deps, { since: SINCE });
    expect([
      report.handled,
      report.truncated,
      report.nextSince,
      headerReads[0],
      headerReads.at(-1),
    ]).toEqual([MAX_PER_POLL, true, minutes(MAX_PER_POLL), "m1", `m${MAX_PER_POLL}`]);
  });

  it("moves on after a truncated run even when more than a batch arrived within the overlap hour", async () => {
    // 250 messages, ten seconds apart: all inside one hour.
    const burst = Array.from({ length: 250 }, (_, i) => ({
      ...message(1),
      id: `m${i + 1}`,
      threadId: `t${i + 1}`,
      receivedAt: new Date(SINCE.getTime() + (i + 1) * 10_000),
    }));
    const { deps, recorded } = fakeDeps(burst);
    const first = await pollNewMail(deps, { since: SINCE });
    const second = await pollNewMail(deps, { since: first.nextSince, overlap: first.nextOverlap });
    expect([first.truncated, first.nextOverlap, second.truncated, second.nextOverlap]).toEqual([
      true,
      false,
      false,
      true,
    ]);
    // Every message reached the step once, m201…m250 in the second run.
    expect([recorded.length, recorded.at(200), recorded.at(-1)]).toEqual([250, "m201", "m250"]);
  });

  it("stops at a message it can't read, so the next tick starts from the last one handled", async () => {
    const { deps, recorded } = fakeDeps([message(1), message(3)]);
    // m2 is listed but its headers can't be read.
    const listIds = deps.gmail.listIds;
    deps.gmail.listIds = async (q) => {
      const ids = await listIds(q);
      return [
        ids[0] as { id: string; threadId: string },
        { id: "m2", threadId: "t2" },
        ...ids.slice(1),
      ];
    };
    const report = await pollNewMail(deps, { since: SINCE });
    expect([
      report.stoppedBy,
      report.stoppedAt,
      report.handled,
      report.nextSince,
      recorded,
    ]).toEqual(["Error", "m2", 1, minutes(1), ["m1"]]);
  });

  it("passes over a message the caller has given up on, so the mail after it still gets through", async () => {
    const { deps, recorded, headerReads } = fakeDeps([message(1), message(3)]);
    const listIds = deps.gmail.listIds;
    deps.gmail.listIds = async (q) => {
      const ids = await listIds(q);
      return [
        ids[0] as { id: string; threadId: string },
        { id: "m2", threadId: "t2" },
        ...ids.slice(1),
      ];
    };
    const report = await pollNewMail(deps, { since: SINCE, skip: new Set(["m2"]) });
    expect([report.passedOver, report.stoppedBy, recorded, headerReads]).toEqual([
      1,
      null,
      ["m1", "m3"],
      ["m1", "m3"],
    ]);
  });

  it("never moves nextSince past the run's start, even for a message dated in the future", async () => {
    const { deps } = fakeDeps([message(1), message(50_000)], { now: () => minutes(5) });
    const report = await pollNewMail(deps, { since: SINCE });
    expect(report.nextSince).toEqual(minutes(5));
  });

  it("keeps since when nothing new was listed", async () => {
    const { deps } = fakeDeps([]);
    expect(await pollNewMail(deps, { since: SINCE })).toMatchObject({
      listed: 0,
      handled: 0,
      nextSince: SINCE,
    });
  });

  it("throws when the listing fails, having read and recorded nothing", async () => {
    const { deps, headerReads, recorded } = fakeDeps([message(1)]);
    deps.gmail.listIds = async () => {
      throw Object.assign(new Error("Gmail answered 503"), { name: "GmailError" });
    };
    await expect(pollNewMail(deps, { since: SINCE })).rejects.toThrow("Gmail answered 503");
    expect([headerReads, recorded]).toEqual([[], []]);
  });
});
