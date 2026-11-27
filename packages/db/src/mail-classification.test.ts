import { CandidateId, DEFAULT_NUDGE_DAYS, nudgesDue } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { readInboxThreads } from "./inbox-read.js";
import { mailClassification } from "./mail-classification-schema.js";
import { readMailClassifications, recordMailClassification } from "./mail-classification-write.js";
import { recordMailLink } from "./mail-link-write.js";
import { readNudgeCandidates } from "./nudge-read.js";
import { domainEvent } from "./schema.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

// Stored mail classifications (NS-261) on PGlite. Invented Gmail ids only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const THREAD = "18c3f0a2b4d6e8aa";
const M1 = "18c3f0a2b4d6e801";
const M2 = "18c3f0a2b4d6e802";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let applicationId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "submitted");
  candidateId = CandidateId.parse(seeded.candidateId);
  applicationId = seeded.applicationId;
});
afterEach(() => close());

// A verified message the mail loop linked to the application, received on the given day.
const link = (id: string, day: number) =>
  recordMailLink(db, {
    candidateId,
    message: { id, threadId: THREAD, receivedAt: new Date(Date.UTC(2026, 10, day, 12)) },
    decision: { kind: "linked", applicationId, step: "tag", senderVerified: true },
  });

const RULES = {
  outcome: "classified",
  kind: "confirmation",
  stageSignal: "none",
  decidedBy: "rules",
};
const MODEL = {
  outcome: "classified",
  kind: "interview_request",
  stageSignal: "screen",
  decidedBy: "model",
  promptVersion: 2,
};
const REVIEW = { outcome: "review", reason: "provenance", promptVersion: 2 };

const record = (gmailMessageId: string, result: unknown) =>
  recordMailClassification(db, { candidateId, gmailMessageId, result });

describe("recordMailClassification", () => {
  it("stores a classification once, and a repeat keeps the first decision", async () => {
    await link(M1, 1);
    expect([await record(M1, RULES), await record(M1, MODEL)]).toEqual([
      { ok: true, value: { recorded: true } },
      { ok: true, value: { recorded: false } },
    ]);
    expect(await readMailClassifications(db, candidateId, [M1])).toEqual([
      {
        gmailMessageId: M1,
        outcome: "classified",
        kind: "confirmation",
        stageSignal: "none",
        decidedBy: "rules",
        reviewReason: null,
      },
    ]);
  });

  it("stores a review with its reason and no kind", async () => {
    await link(M1, 1);
    await record(M1, REVIEW);
    expect(await readMailClassifications(db, candidateId, [M1])).toEqual([
      {
        gmailMessageId: M1,
        outcome: "review",
        kind: null,
        stageSignal: null,
        decidedBy: "model",
        reviewReason: "provenance",
      },
    ]);
  });

  it("refuses a message the mail loop never recorded, and a bad shape", async () => {
    await link(M1, 1);
    expect([
      await record(M2, RULES),
      await record(M1, { ...RULES, kind: "lunch" }),
      await record(M1, { ...MODEL, promptVersion: undefined }),
      await record(M1, { ...RULES, company: "Globex" }),
      await record("not-a-gmail-id", RULES),
    ]).toEqual([
      { ok: false, error: { kind: "UnknownMessage" } },
      { ok: false, error: { kind: "InvalidClassification", fields: ["kind"] } },
      { ok: false, error: { kind: "InvalidClassification", fields: ["promptVersion"] } },
      { ok: false, error: { kind: "InvalidClassification", fields: ["result"] } },
      { ok: false, error: { kind: "InvalidClassification", fields: ["gmailMessageId"] } },
    ]);
    expect(await db.select().from(mailClassification)).toHaveLength(0);
  });

  it("writes one event per decision with codes only and a fixed sentence", async () => {
    await link(M1, 1);
    await link(M2, 2);
    await record(M1, MODEL);
    await record(M2, REVIEW);
    const rows = await db
      .select({ type: domainEvent.type, reason: domainEvent.reason, payload: domainEvent.payload })
      .from(domainEvent)
      .where(sql`${domainEvent.type} like 'mail.%'`)
      .orderBy(domainEvent.position);
    expect(rows.map((r) => [r.type, r.reason, r.payload])).toEqual([
      [
        "mail.classified",
        "Sorted a job email: an interview request",
        {
          gmailMessageId: M1,
          kind: "interview_request",
          stageSignal: "screen",
          decidedBy: "model",
        },
      ],
      [
        "mail.needs_review",
        "A job email needs your review: it couldn't be sorted with confidence",
        { gmailMessageId: M2, reason: "provenance" },
      ],
    ]);
  });
});

describe("the mail_classification table", () => {
  it("refuses UPDATE, DELETE and TRUNCATE", async () => {
    await link(M1, 1);
    await record(M1, RULES);
    expect([
      await sqlState(db.execute(sql`UPDATE mail_classification SET kind = 'offer'`)),
      await sqlState(db.execute(sql`DELETE FROM mail_classification`)),
      await sqlState(db.execute(sql`TRUNCATE mail_classification`)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });

  it("refuses rows of the wrong shape written directly", async () => {
    const insert = (row: Partial<typeof mailClassification.$inferInsert>) =>
      sqlState(
        db.insert(mailClassification).values({
          candidateId,
          gmailMessageId: M1,
          outcome: "classified",
          kind: "confirmation",
          stageSignal: "none",
          decidedBy: "rules",
          ...row,
        }),
      );
    expect([
      await insert({ kind: "lunch" }),
      await insert({ kind: null }),
      await insert({ reviewReason: "refused" }),
      await insert({ outcome: "review", kind: null, stageSignal: null, reviewReason: "refused" }),
      await insert({ decidedBy: "model" }),
      await insert({ promptVersion: 3 }),
    ]).toEqual(Array(6).fill(CHECK_VIOLATION));
  });
});

describe("reads that use the stored kind", () => {
  it("shows a thread's newest classified kind in the inbox, skipping a newer review", async () => {
    await link(M1, 1);
    await link(M2, 2);
    expect((await readInboxThreads(db, candidateId)).applications[0]?.threads[0]?.kind).toBeNull();
    await record(M1, MODEL);
    await record(M2, REVIEW);
    expect((await readInboxThreads(db, candidateId)).applications[0]?.threads[0]?.kind).toBe(
      "interview_request",
    );
  });

  it("gives the nudge check the newest message's stored kind, or null in review", async () => {
    await link(M1, 1);
    const before = await readNudgeCandidates(db, candidateId);
    await record(M1, RULES);
    const after = await readNudgeCandidates(db, candidateId);
    expect([before[0]?.lastMail?.kind, after[0]?.lastMail?.kind]).toEqual([null, "confirmation"]);
    await link(M2, 2);
    await record(M2, REVIEW);
    expect((await readNudgeCandidates(db, candidateId))[0]?.lastMail?.kind).toBeNull();
  });

  it("lets a nudge come due from a stored confirmation, and not before it is stored", async () => {
    await link(M1, 1);
    const before = await readNudgeCandidates(db, candidateId);
    const row = before[0];
    if (!row?.lastMail) throw new Error("no candidate row");
    // Eight days after the newest sign of life: past the applied stage's 7.
    const lastActivity = Math.max(row.lastMoveAt.getTime(), row.lastMail.receivedAt.getTime());
    const now = new Date(lastActivity + 8 * 24 * 60 * 60 * 1000);
    await record(M1, RULES);
    const after = await readNudgeCandidates(db, candidateId);
    expect([
      nudgesDue(before, DEFAULT_NUDGE_DAYS, now).map((d) => d.gmailMessageId),
      nudgesDue(after, DEFAULT_NUDGE_DAYS, now).map((d) => [d.applicationId, d.gmailMessageId]),
    ]).toEqual([[], [[applicationId, M1]]]);
  });
});

describe("readMailClassifications", () => {
  it("reads nothing for no ids, and never another candidate's rows", async () => {
    await link(M1, 1);
    await record(M1, RULES);
    const other = CandidateId.parse((await seedApplication(db, "submitted")).candidateId);
    expect([
      await readMailClassifications(db, candidateId, []),
      await readMailClassifications(db, other, [M1]),
    ]).toEqual([[], []]);
    expect(
      (await db.select().from(mailClassification).where(eq(mailClassification.gmailMessageId, M1)))
        .length,
    ).toBe(1);
  });
});
