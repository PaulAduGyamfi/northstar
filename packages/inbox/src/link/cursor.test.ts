import { describe, expect, it } from "vitest";
import type { MessageHeaders } from "../gmail.js";
import { FutureCursorError, type MailCursor, pollFromCursor } from "./cursor.js";
import { type MailPollDeps, newMailQuery } from "./poll.js";

// One poll tick with a stored cursor (NS-247 slice 2) on a fake Gmail client and a fake store.
// Synthetic mail only.

const MAILBOX = "candidate@example.com";
const FIRST = new Date("2026-11-25T12:00:00Z");
const APP = "00000000-0000-4000-8000-0000000000a1";
const minutes = (n: number) => new Date(FIRST.getTime() + n * 60_000);

const tagged = (n: number): MessageHeaders => ({
  id: `m${n}`,
  threadId: `t${n}`,
  from: "Globex Recruiting <talent@globex.example>",
  senderDomain: "globex.example",
  subject: "Next steps",
  deliveredTo: "candidate+ns-k3q2m7@example.com",
  authenticationResults: null,
  receivedAt: minutes(n),
  labelIds: ["INBOX"],
});

function setup(messages: MessageHeaders[], stored: MailCursor | null, failOn?: string) {
  const queries: string[] = [];
  const saved: MailCursor[] = [];
  let cursor = stored;
  const deps: MailPollDeps & {
    cursor: { read: () => Promise<MailCursor | null>; save: (c: MailCursor) => Promise<void> };
  } = {
    mailbox: MAILBOX,
    now: () => minutes(10_000),
    knownDomains: new Set(),
    gmail: {
      listIds: async (q) => {
        queries.push(q);
        const after = Number(q.match(/after:(\d+)/)?.[1] ?? 0) * 1000;
        return messages
          .filter((m) => m.receivedAt.getTime() > after)
          .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
          .map((m) => ({ id: m.id, threadId: m.threadId }));
      },
      getHeaders: async (id) => {
        if (id === failOn) throw new Error("read failed");
        const m = messages.find((x) => x.id === id);
        if (!m) throw new Error("missing");
        return m;
      },
    },
    openWindows: async () => [],
    readTags: async () => [{ tag: "k3q2m7", applicationId: APP, tenantKey: null }],
    readCandidates: async () => [
      { applicationId: APP, createdAt: new Date("2026-11-01T00:00:00Z"), ats: [] },
    ],
    readLinkedThreads: async () => new Map(),
    record: async () => ({ recorded: true }),
    cursor: {
      read: async () => cursor,
      save: async (c) => {
        saved.push(c);
        cursor = c;
      },
    },
  };
  return { deps, queries, saved };
}

describe("pollFromCursor", () => {
  it("starts the very first run from firstSince and saves where it stopped", async () => {
    const { deps, queries, saved } = setup([tagged(5), tagged(9)], null);
    const report = await pollFromCursor(deps, { firstSince: FIRST });
    expect([queries, report.handled, saved]).toEqual([
      [newMailQuery(FIRST, true)],
      2,
      [{ since: minutes(9), overlap: true }],
    ]);
  });

  it("resumes from the stored cursor, not firstSince", async () => {
    const { deps, queries } = setup([tagged(5)], { since: minutes(3), overlap: false });
    await pollFromCursor(deps, { firstSince: FIRST });
    expect(queries).toEqual([newMailQuery(minutes(3), false)]);
  });

  it("saves the cursor of a run that stopped at a message, so nothing after it is skipped", async () => {
    const { deps, saved } = setup([tagged(5), tagged(7), tagged(9)], null, "m7");
    const report = await pollFromCursor(deps, { firstSince: FIRST });
    expect([report.stoppedAt, saved]).toEqual(["m7", [{ since: minutes(5), overlap: true }]]);
  });

  it("fails visibly on a future first start or stored cursor, before asking Gmail anything", async () => {
    const late = setup([tagged(5)], null);
    await expect(pollFromCursor(late.deps, { firstSince: minutes(20_000) })).rejects.toBeInstanceOf(
      FutureCursorError,
    );
    const stored = setup([tagged(5)], { since: minutes(20_000), overlap: true });
    await expect(pollFromCursor(stored.deps, { firstSince: FIRST })).rejects.toBeInstanceOf(
      FutureCursorError,
    );
    expect([late.queries, late.saved, stored.queries, stored.saved]).toEqual([[], [], [], []]);
  });

  it("throws a failed save, so the next tick reads the old cursor again", async () => {
    const { deps } = setup([tagged(5)], null);
    deps.cursor.save = async () => {
      throw new Error("database down");
    };
    await expect(pollFromCursor(deps, { firstSince: FIRST })).rejects.toThrow("database down");
  });
});
