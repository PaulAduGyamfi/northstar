import { CandidateId } from "@northstar/domain";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { recordMailLink } from "./mail-link-write.js";
import { recordRecruiterGrade } from "./recruiter-grade-write.js";
import { regradeRecruiterMessage } from "./recruiter-regrade-write.js";
import { recruiterWeight } from "./recruiter-weight-schema.js";
import { readRecruiterWeights } from "./recruiter-weight-write.js";
import { candidate, domainEvent } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";

// Recruiter grading learning from Paul's regrades (NS-238 item 3 slice 2, REC-003) on PGlite.
// Invented Gmail ids only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const M1 = "18c3f0a2b4d6e801";
const M2 = "18c3f0a2b4d6e802";
const M3 = "18c3f0a2b4d6e803";
const M4 = "18c3f0a2b4d6e804";
const M5 = "18c3f0a2b4d6e805";
const M6 = "18c3f0a2b4d6e806";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

// A recorded recruiter email graded B for an exact title from an agency.
async function gradedMail(id: string, reasons = ["title:exact", "sender:agency"]) {
  await recordMailLink(db, {
    candidateId,
    message: { id, threadId: id, receivedAt: new Date(Date.UTC(2026, 10, 1, 12)) },
    decision: { kind: "queued", reason: "no_match" },
  });
  const graded = await recordRecruiterGrade(db, {
    candidateId,
    gmailMessageId: id,
    grade: { grade: "B", points: 4, reasons, confidence: "normal" },
  });
  if (!graded.ok) throw new Error(graded.error.kind);
}

const regrade = (gmailMessageId: string, grade: string) =>
  regradeRecruiterMessage(db, { candidateId, gmailMessageId, grade });

const weightEvents = () =>
  db
    .select({ actor: domainEvent.actor, reason: domainEvent.reason, payload: domainEvent.payload })
    .from(domainEvent)
    .where(sql`${domainEvent.type} = 'recruiter.weights_adjusted'`)
    .orderBy(domainEvent.position);

const versions = async () => (await db.select().from(recruiterWeight)).length;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  candidateId = CandidateId.parse(c.id);
  for (const id of [M1, M2, M3]) await gradedMail(id);
});
afterEach(() => close());

describe("learning from regrades", () => {
  it("learns nothing until three regraded messages share a reason", async () => {
    await regrade(M1, "D");
    await regrade(M2, "D");
    expect([
      await readRecruiterWeights(db, candidateId),
      await versions(),
      await weightEvents(),
    ]).toEqual([{}, 0, []]);
  });

  it("stores a version and a system event once the third regrade teaches it", async () => {
    for (const id of [M1, M2, M3]) await regrade(id, "D");
    expect(await readRecruiterWeights(db, candidateId)).toEqual({
      "title:exact": -2,
      "sender:agency": -2,
    });
    expect(await weightEvents()).toEqual([
      {
        actor: "system",
        reason: "Adjusted recruiter grading from your regrades: 2 changes",
        payload: { changes: { "title:exact": -2, "sender:agency": -2 }, regrades: 3 },
      },
    ]);
  });

  it("stores nothing when a regrade leaves the result the same, and a version when it moves", async () => {
    for (const id of [M1, M2, M3]) await regrade(id, "D");
    // Deltas -1, -2, -2: the mean still rounds to -2.
    await regrade(M1, "C");
    expect(await versions()).toBe(1);
    // Deltas +1, -2, -2: the mean is -1.
    await regrade(M1, "A");
    expect([
      await versions(),
      await readRecruiterWeights(db, candidateId),
      (await weightEvents()).at(-1)?.payload,
    ]).toEqual([
      2,
      { "title:exact": -1, "sender:agency": -1 },
      { changes: { "title:exact": -1, "sender:agency": -1 }, regrades: 3 },
    ]);
  });

  it("never adjusts a cap, and keeps each candidate's weights apart", async () => {
    // Three messages carry the dealbreaker, so it would be learned if caps weren't left out.
    for (const id of [M4, M5, M6]) await gradedMail(id, ["dealbreaker"]);
    // B to A is +1 on each message.
    for (const id of [M1, M2, M3, M4, M5, M6]) await regrade(id, "A");
    const [o] = await db.insert(candidate).values({ displayName: "Other" }).returning();
    if (!o) throw new Error("no candidate");
    expect([
      await readRecruiterWeights(db, candidateId),
      await readRecruiterWeights(db, CandidateId.parse(o.id)),
    ]).toEqual([{ "title:exact": 1, "sender:agency": 1 }, {}]);
  });

  it("stores an empty version when Paul's letters take every adjustment back to none", async () => {
    for (const id of [M1, M2, M3]) await regrade(id, "D");
    // Back to B one at a time: deltas 0, -2, -2 (mean -4/3, so -1), then 0, 0, -2 (still -1),
    // then all 0 (none): three versions in all.
    for (const id of [M1, M2, M3]) await regrade(id, "B");
    expect([
      await versions(),
      await readRecruiterWeights(db, candidateId),
      (await weightEvents()).at(-1),
    ]).toEqual([
      3,
      {},
      {
        actor: "system",
        reason: "Adjusted recruiter grading from your regrades: 2 changes",
        payload: { changes: { "title:exact": 0, "sender:agency": 0 }, regrades: 3 },
      },
    ]);
  });
});

describe("the recruiter_weight table", () => {
  it("refuses UPDATE, DELETE and TRUNCATE, and an out-of-bound, unlisted or unpaired value", async () => {
    for (const id of [M1, M2, M3]) await regrade(id, "D");
    const row = { candidateId, regrades: 3 };
    const insert = (reasons: string[], adjustments: number[]) =>
      sqlState(db.insert(recruiterWeight).values({ ...row, reasons, adjustments }));
    expect([
      await sqlState(db.update(recruiterWeight).set({ regrades: 4 })),
      await sqlState(db.delete(recruiterWeight)),
      await sqlState(db.execute(sql`truncate recruiter_weight`)),
      await insert(["pay:ok"], [3]),
      await insert(["pay:ok"], [0]),
      await insert(["dealbreaker"], [1]),
      await insert(["pay:ok", "pay:below"], [1]),
    ]).toEqual([
      RESTRICT_VIOLATION,
      RESTRICT_VIOLATION,
      RESTRICT_VIOLATION,
      CHECK_VIOLATION,
      CHECK_VIOLATION,
      CHECK_VIOLATION,
      CHECK_VIOLATION,
    ]);
  });
});
