import { CandidateId } from "@northstar/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { recordFactsCheck } from "./facts-write.js";
import { funnelManualRow, funnelMessage } from "./funnel-schema.js";
import {
  type FunnelMessageInput,
  knownGmailIds,
  latestFactsCheck,
  type ManualRowInput,
  readFunnelMessages,
  readManualRows,
  recordFunnelEvent,
  resolveReview,
  saveFunnelMessages,
  setManualRows,
} from "./funnel-write.js";
import { candidate, domainEvent } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";

const CHECK_VIOLATION = "23514";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

// Synthetic companies and ids only (the repo is public).
const confirmation: FunnelMessageInput = {
  gmailId: "m1",
  threadId: "t1",
  senderDomain: "ats.example.com",
  receivedAt: new Date("2026-03-02T15:00:00Z"),
  status: "classified",
  kind: "confirmation",
  company: "Globex",
  role: "Backend Engineer",
  requisition: null,
  stageSignal: "none",
  classifiedBy: "rules",
  reviewReason: null,
  promptVersion: null,
  model: null,
};
const review: FunnelMessageInput = {
  ...confirmation,
  gmailId: "m2",
  status: "needs_review",
  kind: null,
  company: null,
  role: null,
  stageSignal: null,
  classifiedBy: null,
  reviewReason: "provenance",
};
const row: ManualRowInput = {
  line: 2,
  company: "Initech",
  role: "Platform Engineer",
  appliedOn: "2026-04-01",
  stageReached: "screen",
  outcome: "rejected",
  outcomeOn: "2026-04-20",
  channel: "referral",
};

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  candidateId = CandidateId.parse(c.id);
});

afterEach(async () => {
  await close();
});

const events = () =>
  db
    .select()
    .from(domainEvent)
    .where(eq(domainEvent.candidateId, candidateId))
    .orderBy(domainEvent.position);

describe("funnel messages", () => {
  it("saving the same message twice stores it once", async () => {
    expect(await saveFunnelMessages(db, candidateId, [confirmation])).toBe(1);
    expect(await saveFunnelMessages(db, candidateId, [confirmation])).toBe(0);
    expect(await db.select().from(funnelMessage)).toHaveLength(1);
  });

  it("knownGmailIds returns only the ids already processed", async () => {
    await saveFunnelMessages(db, candidateId, [confirmation]);
    expect(await knownGmailIds(db, candidateId, ["m1", "m9"])).toEqual(new Set(["m1"]));
  });

  it("readFunnelMessages leaves out messages the pre-filter dropped", async () => {
    await saveFunnelMessages(db, candidateId, [
      confirmation,
      { ...review, gmailId: "m3", status: "not_job", senderDomain: null, reviewReason: null },
    ]);
    expect((await readFunnelMessages(db, candidateId)).map((m) => m.gmailId)).toEqual(["m1"]);
  });

  it("the database refuses a classified message without a company", async () => {
    const bad = db.insert(funnelMessage).values({ ...confirmation, company: null, candidateId });
    expect(await sqlState(bad)).toBe(CHECK_VIOLATION);
  });

  it("the database refuses a review item without a reason", async () => {
    const bad = db.insert(funnelMessage).values({ ...review, reviewReason: null, candidateId });
    expect(await sqlState(bad)).toBe(CHECK_VIOLATION);
  });

  it("resolving a review item classifies it as Paul's and writes a counts-only event", async () => {
    await saveFunnelMessages(db, candidateId, [review]);
    const [item] = await readFunnelMessages(db, candidateId);
    const result = await resolveReview(db, {
      candidateId,
      messageId: item?.id ?? "",
      decision: {
        action: "classify",
        kind: "rejection",
        company: "Globex",
        role: "Backend Engineer",
        stageSignal: "none",
      },
    });
    expect(result).toEqual({ ok: true, value: { status: "classified" } });
    const [after] = await readFunnelMessages(db, candidateId);
    expect(after).toMatchObject({ status: "classified", classifiedBy: "paul", kind: "rejection" });
    const [event] = await events();
    expect(event?.type).toBe("funnel.reviewed");
    expect(event?.payload).toEqual({ action: "classify" });
  });

  it("a discarded review item stays stored but leaves the funnel", async () => {
    await saveFunnelMessages(db, candidateId, [review]);
    const [item] = await readFunnelMessages(db, candidateId);
    await resolveReview(db, {
      candidateId,
      messageId: item?.id ?? "",
      decision: { action: "discard" },
    });
    expect((await readFunnelMessages(db, candidateId))[0]?.status).toBe("discarded");
  });

  it("resolving a message that isn't waiting for review is refused", async () => {
    await saveFunnelMessages(db, candidateId, [confirmation]);
    const [item] = await readFunnelMessages(db, candidateId);
    const result = await resolveReview(db, {
      candidateId,
      messageId: item?.id ?? "",
      decision: { action: "discard" },
    });
    expect(result).toEqual({ ok: false, error: { kind: "NotInReview" } });
  });
});

describe("manual history rows", () => {
  it("an import stores the rows and a counts-only event", async () => {
    expect(await setManualRows(db, { candidateId, fileSha256: SHA_A, rows: [row] })).toEqual({
      status: "imported",
      rows: 1,
    });
    expect(await readManualRows(db, candidateId)).toEqual([row]);
    const [event] = await events();
    expect(event?.type).toBe("funnel.imported");
    expect(event?.payload).toEqual({ rows: 1 });
  });

  it("importing the same file again changes nothing", async () => {
    await setManualRows(db, { candidateId, fileSha256: SHA_A, rows: [row] });
    expect(await setManualRows(db, { candidateId, fileSha256: SHA_A, rows: [row] })).toEqual({
      status: "unchanged",
      rows: 1,
    });
    expect(await db.select().from(funnelManualRow)).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it("a new export replaces the current rows and keeps the old ones as superseded", async () => {
    await setManualRows(db, { candidateId, fileSha256: SHA_A, rows: [row] });
    const next = { ...row, stageReached: "technical" as const };
    await setManualRows(db, { candidateId, fileSha256: SHA_B, rows: [next] });
    expect(await readManualRows(db, candidateId)).toEqual([next]);
    expect(await db.select().from(funnelManualRow)).toHaveLength(2);
  });

  it("the database refuses an unknown stage", async () => {
    const bad = db.insert(funnelManualRow).values({
      ...row,
      stageReached: "phone",
      candidateId,
      fileSha256: SHA_A,
    });
    expect(await sqlState(bad)).toBe(CHECK_VIOLATION);
  });
});

describe("funnel events and the facts check", () => {
  it("recordFunnelEvent writes the given counts", async () => {
    await recordFunnelEvent(db, {
      candidateId,
      type: "funnel.backfilled",
      reason: "Backfill finished",
      payload: { listed: 10, fetched: 4 },
    });
    const [event] = await events();
    expect(event).toMatchObject({ type: "funnel.backfilled", actor: "user" });
    expect(event?.payload).toEqual({ listed: 10, fetched: 4 });
  });

  it("latestFactsCheck is null before any check and the latest count after", async () => {
    expect(await latestFactsCheck(db, candidateId)).toBeNull();
    await recordFactsCheck(db, { candidateId, claims: 2, mismatches: [] });
    await recordFactsCheck(db, {
      candidateId,
      claims: 2,
      mismatches: [{ source: "resume", field: "end" }],
    });
    expect(await latestFactsCheck(db, candidateId)).toEqual({ mismatches: 1 });
  });
});
