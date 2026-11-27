import { CandidateId } from "@northstar/domain";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { readInboxThreads } from "./inbox-read.js";
import { mailClassification } from "./mail-classification-schema.js";
import { readMailClassifications, recordMailClassification } from "./mail-classification-write.js";
import { recordMailLink } from "./mail-link-write.js";
import { readUnclassifiedMail } from "./mail-loop-read.js";
import { readNudgeCandidates } from "./nudge-read.js";
import { readInboxCreditReport } from "./origin-write.js";
import { domainEvent } from "./schema.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

// Verification mail the classifier left alone (NS-271) on PGlite. Invented Gmail ids only, and no
// code or body anywhere: only the fixed outcome is stored.

const CHECK_VIOLATION = "23514";
const THREAD = "18c3f0a2b4d6e9aa";
const M1 = "18c3f0a2b4d6e901";
const M2 = "18c3f0a2b4d6e902";
const SKIPPED = { outcome: "skipped", reason: "verification" };

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

const record = (gmailMessageId: string, result: unknown) =>
  recordMailClassification(db, { candidateId, gmailMessageId, result });

describe("recordMailClassification for verification mail", () => {
  it("stores that it was left alone once, with no kind, reason or prompt version", async () => {
    await link(M1, 1);
    expect([await record(M1, SKIPPED), await record(M1, SKIPPED)]).toEqual([
      { ok: true, value: { recorded: true } },
      { ok: true, value: { recorded: false } },
    ]);
    expect(await readMailClassifications(db, candidateId, [M1])).toEqual([
      {
        gmailMessageId: M1,
        outcome: "skipped",
        kind: null,
        stageSignal: null,
        decidedBy: "rules",
        reviewReason: null,
      },
    ]);
  });

  it("writes one event with the message id only and a fixed sentence", async () => {
    await link(M1, 1);
    await record(M1, SKIPPED);
    const rows = await db
      .select({ type: domainEvent.type, reason: domainEvent.reason, payload: domainEvent.payload })
      .from(domainEvent)
      .where(sql`${domainEvent.type} = 'mail.verification_left_alone'`);
    expect(rows).toEqual([
      {
        type: "mail.verification_left_alone",
        reason: "Left a verification email alone",
        payload: { gmailMessageId: M1 },
      },
    ]);
  });

  it("refuses a skipped outcome with another reason or any other field", async () => {
    await link(M1, 1);
    expect([
      await record(M1, { ...SKIPPED, reason: "spam" }),
      await record(M1, { ...SKIPPED, code: "123456" }),
      await record(M1, { ...SKIPPED, kind: "confirmation" }),
    ]).toEqual([
      { ok: false, error: { kind: "InvalidClassification", fields: ["reason"] } },
      { ok: false, error: { kind: "InvalidClassification", fields: ["result"] } },
      { ok: false, error: { kind: "InvalidClassification", fields: ["result"] } },
    ]);
    expect(await db.select().from(mailClassification)).toHaveLength(0);
  });
});

describe("the mail_classification table for skipped rows", () => {
  it("refuses a skipped row with a kind, stage, reason, prompt version or the model", async () => {
    const insert = (row: Partial<typeof mailClassification.$inferInsert>) =>
      sqlState(
        db.insert(mailClassification).values({
          candidateId,
          gmailMessageId: M1,
          outcome: "skipped",
          decidedBy: "rules",
          ...row,
        }),
      );
    expect([
      await insert({ kind: "confirmation" }),
      await insert({ stageSignal: "none" }),
      await insert({ reviewReason: "refused" }),
      await insert({ promptVersion: 2 }),
      await insert({ decidedBy: "model", promptVersion: 2 }),
    ]).toEqual(Array(5).fill(CHECK_VIOLATION));
  });
});

describe("reads after a verification email was left alone", () => {
  it("leaves it out of the mail loop's unclassified mail", async () => {
    await link(M1, 1);
    await link(M2, 2);
    await record(M2, SKIPPED);
    expect((await readUnclassifiedMail(db, candidateId, 25)).map((m) => m.gmailMessageId)).toEqual([
      M1,
    ]);
  });

  it("shows the thread as verification in the inbox when it is the newest decided message", async () => {
    await link(M1, 1);
    await link(M2, 2);
    await record(M1, {
      outcome: "classified",
      kind: "confirmation",
      stageSignal: "none",
      decidedBy: "rules",
    });
    await record(M2, SKIPPED);
    expect((await readInboxThreads(db, candidateId)).applications[0]?.threads[0]?.kind).toBe(
      "verification",
    );
  });

  it("counts nowhere in the credit report or the nudge check", async () => {
    await link(M1, 1);
    await record(M1, SKIPPED);
    const report = await readInboxCreditReport(db, candidateId);
    expect([
      Object.values(report).map((s) => s.replied + s.screen + s.interview),
      (await readNudgeCandidates(db, candidateId))[0]?.lastMail?.kind,
    ]).toEqual([[0, 0, 0, 0, 0], null]);
  });
});
