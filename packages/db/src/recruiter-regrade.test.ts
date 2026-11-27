import { CandidateId } from "@northstar/domain";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { readInboxThreads } from "./inbox-read.js";
import { recordMailLink } from "./mail-link-write.js";
import { recordRecruiterGrade } from "./recruiter-grade-write.js";
import { recruiterRegrade } from "./recruiter-regrade-schema.js";
import { readRegrades, regradeRecruiterMessage, regradeThread } from "./recruiter-regrade-write.js";
import { candidate, domainEvent } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";

// Paul's regrade of a recruiter email (NS-238 item 3, REC-003) on PGlite. Invented Gmail ids only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const THREAD = "18c3f0a2b4d6e8aa";
const M1 = "18c3f0a2b4d6e801";
const M2 = "18c3f0a2b4d6e802";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

async function newCandidate(): Promise<CandidateId> {
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  return CandidateId.parse(c.id);
}

// A recruiter email the mail loop recorded (queued, no application) on the given day, graded B.
async function gradedMail(owner: CandidateId, id: string, day: number, grade = "B") {
  await recordMailLink(db, {
    candidateId: owner,
    message: { id, threadId: THREAD, receivedAt: new Date(Date.UTC(2026, 10, day, 12)) },
    decision: { kind: "queued", reason: "no_match" },
  });
  const graded = await recordRecruiterGrade(db, {
    candidateId: owner,
    gmailMessageId: id,
    grade: { grade, points: 4, reasons: ["title:exact"], confidence: "normal" },
  });
  if (!graded.ok) throw new Error(graded.error.kind);
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = await newCandidate();
});
afterEach(() => close());

const regrade = (grade: string, gmailMessageId = M1) =>
  regradeRecruiterMessage(db, { candidateId, gmailMessageId, grade });

describe("regradeRecruiterMessage", () => {
  it("stores Paul's letter once, a repeat stores nothing, and a later letter becomes current", async () => {
    await gradedMail(candidateId, M1, 1);
    expect([await regrade("D"), await regrade("D"), await regrade("C")]).toEqual([
      { ok: true, value: { recorded: true } },
      { ok: true, value: { recorded: false } },
      { ok: true, value: { recorded: true } },
    ]);
    expect([
      (await db.select().from(recruiterRegrade)).length,
      await readRegrades(db, candidateId, [M1]),
    ]).toEqual([2, new Map([[M1, "C"]])]);
  });

  it("writes one event per stored regrade, by Paul, with letters only", async () => {
    await gradedMail(candidateId, M1, 1);
    await regrade("D");
    await regrade("D");
    const events = await db
      .select({
        actor: domainEvent.actor,
        reason: domainEvent.reason,
        payload: domainEvent.payload,
      })
      .from(domainEvent)
      .where(sql`${domainEvent.type} = 'recruiter.regraded'`);
    expect(events).toEqual([
      {
        actor: "user",
        reason: "You regraded a recruiter email: B to D",
        payload: { gmailMessageId: M1, systemGrade: "B", grade: "D" },
      },
    ]);
  });

  it("refuses an ungraded or another candidate's message, a bad letter and a bad id", async () => {
    const other = await newCandidate();
    await gradedMail(other, M2, 1);
    expect([
      await regrade("D"),
      await regrade("D", M2),
      await regrade("E"),
      await regrade("D", "Not hex"),
    ]).toEqual([
      { ok: false, error: { kind: "NotGraded" } },
      { ok: false, error: { kind: "NotGraded" } },
      { ok: false, error: { kind: "InvalidRegrade", fields: ["grade"] } },
      { ok: false, error: { kind: "InvalidRegrade", fields: ["gmailMessageId"] } },
    ]);
    expect((await db.select().from(recruiterRegrade)).length).toBe(0);
  });
});

describe("regradeThread", () => {
  it("regrades the thread's newest graded message, and refuses a thread with none", async () => {
    await gradedMail(candidateId, M1, 1);
    await gradedMail(candidateId, M2, 2);
    expect([
      await regradeThread(db, { candidateId, gmailThreadId: THREAD, grade: "A" }),
      await regradeThread(db, { candidateId, gmailThreadId: "18c3f0a2b4d6e8bb", grade: "A" }),
      await regradeThread(db, { candidateId, gmailThreadId: "x/y", grade: "A" }),
      await readRegrades(db, candidateId, [M1, M2]),
    ]).toEqual([
      { ok: true, value: { recorded: true } },
      { ok: false, error: { kind: "NotGraded" } },
      { ok: false, error: { kind: "InvalidRegrade", fields: ["gmailThreadId"] } },
      new Map([[M2, "A"]]),
    ]);
  });
});

describe("the Inbox read", () => {
  it("shows Paul's newest letter beside the system's, and none before he regrades", async () => {
    await gradedMail(candidateId, M1, 1);
    const before = (await readInboxThreads(db, candidateId)).queued[0]?.recruiterGrade;
    await regrade("F");
    const after = (await readInboxThreads(db, candidateId)).queued[0]?.recruiterGrade;
    expect([before?.paulGrade, after?.grade, after?.paulGrade]).toEqual([undefined, "B", "F"]);
  });
});

describe("the recruiter_regrade table", () => {
  it("refuses UPDATE, DELETE and TRUNCATE, and a bad letter or id written directly", async () => {
    await gradedMail(candidateId, M1, 1);
    await regrade("D");
    const row = { candidateId, gmailMessageId: M1 };
    expect([
      await sqlState(db.update(recruiterRegrade).set({ grade: "A" })),
      await sqlState(db.delete(recruiterRegrade)),
      await sqlState(db.execute(sql`truncate recruiter_regrade`)),
      await sqlState(db.insert(recruiterRegrade).values({ ...row, grade: "E" })),
      await sqlState(
        db.insert(recruiterRegrade).values({ ...row, gmailMessageId: "Not hex", grade: "A" }),
      ),
    ]).toEqual([
      RESTRICT_VIOLATION,
      RESTRICT_VIOLATION,
      RESTRICT_VIOLATION,
      CHECK_VIOLATION,
      CHECK_VIOLATION,
    ]);
  });
});
