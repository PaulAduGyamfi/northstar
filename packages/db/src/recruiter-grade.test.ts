import { CandidateId } from "@northstar/domain";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { readFeed } from "./feed-read.js";
import { recordMailLink } from "./mail-link-write.js";
import { recruiterGrade } from "./recruiter-grade-schema.js";
import { readRecruiterGrades, recordRecruiterGrade } from "./recruiter-grade-write.js";
import { candidate, domainEvent } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";

// Recruiter grades (NS-238 slice 1) on PGlite. Invented Gmail ids only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
afterAll(() => trace.disable());

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

async function newCandidate(): Promise<CandidateId> {
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  return CandidateId.parse(c.id);
}

// A recruiter email as the mail loop records it: no application, so it waits to be linked.
async function recordMail(owner: CandidateId, id: string) {
  await recordMailLink(db, {
    candidateId: owner,
    message: { id, threadId: "18c3f0a2b4d6e8aa", receivedAt: new Date("2026-11-20T12:00:00Z") },
    decision: { kind: "queued", reason: "no_match" },
  });
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = await newCandidate();
  exporter.reset();
});
afterEach(() => close());

const MSG = "18c3f0a2b4d6e801";
const GRADE = {
  grade: "B",
  points: 4,
  reasons: ["title:exact", "pay:unknown", "place:ok", "sender:in_house"],
  confidence: "normal",
};

describe("recordRecruiterGrade", () => {
  it("stores the grade with one recruiter.graded event carrying codes only", async () => {
    await recordMail(candidateId, MSG);
    const recorded = await recordRecruiterGrade(db, {
      candidateId,
      gmailMessageId: MSG,
      grade: GRADE,
    });
    const events = await db
      .select({ type: domainEvent.type, payload: domainEvent.payload })
      .from(domainEvent)
      .where(sql`${domainEvent.type} = 'recruiter.graded'`);
    expect([recorded, await readRecruiterGrades(db, candidateId, [MSG]), events]).toEqual([
      { ok: true, value: { recorded: true } },
      [{ gmailMessageId: MSG, grade: "B", reasons: GRADE.reasons, confidence: "normal" }],
      [
        {
          type: "recruiter.graded",
          payload: {
            gmailMessageId: MSG,
            grade: "B",
            confidence: "normal",
            reasons: GRADE.reasons,
          },
        },
      ],
    ]);
  });

  it("says it in the feed with fixed words and the grade, and when there was little to go on", async () => {
    await recordMail(candidateId, MSG);
    await recordMail(candidateId, "18c3f0a2b4d6e802");
    await recordRecruiterGrade(db, { candidateId, gmailMessageId: MSG, grade: GRADE });
    await recordRecruiterGrade(db, {
      candidateId,
      gmailMessageId: "18c3f0a2b4d6e802",
      grade: { ...GRADE, grade: "D", confidence: "low" },
    });
    const feed = await readFeed(db, candidateId, { limit: 50 });
    expect(feed.map((i) => i.line).filter((l) => l.startsWith("Graded"))).toEqual([
      "Graded a recruiter email: D (little to go on)",
      "Graded a recruiter email: B",
    ]);
  });

  it("keeps the first grade: grading the same message again stores nothing", async () => {
    await recordMail(candidateId, MSG);
    await recordRecruiterGrade(db, { candidateId, gmailMessageId: MSG, grade: GRADE });
    const again = await recordRecruiterGrade(db, {
      candidateId,
      gmailMessageId: MSG,
      grade: { ...GRADE, grade: "F" },
    });
    const events = await db
      .select({ id: domainEvent.id })
      .from(domainEvent)
      .where(sql`${domainEvent.type} = 'recruiter.graded'`);
    expect([
      again,
      (await readRecruiterGrades(db, candidateId, [MSG]))[0]?.grade,
      events.length,
    ]).toEqual([{ ok: true, value: { recorded: false } }, "B", 1]);
  });

  it("refuses a message the mail loop never recorded, and a bad grade by field", async () => {
    await recordMail(candidateId, MSG);
    expect([
      await recordRecruiterGrade(db, {
        candidateId,
        gmailMessageId: "18c3f0a2b4d6e8ff",
        grade: GRADE,
      }),
      await recordRecruiterGrade(db, {
        candidateId,
        gmailMessageId: MSG,
        grade: { ...GRADE, grade: "E", reasons: ["Dear Paul, call me"] },
      }),
      await recordRecruiterGrade(db, { candidateId, gmailMessageId: "not hex", grade: GRADE }),
    ]).toEqual([
      { ok: false, error: { kind: "UnknownMessage" } },
      { ok: false, error: { kind: "InvalidGrade", fields: ["grade", "reasons"] } },
      { ok: false, error: { kind: "InvalidGrade", fields: ["gmailMessageId"] } },
    ]);
  });

  it("reads no other candidate's grade, and refuses grading another candidate's message", async () => {
    await recordMail(candidateId, MSG);
    await recordRecruiterGrade(db, { candidateId, gmailMessageId: MSG, grade: GRADE });
    const other = await newCandidate();
    expect([
      await readRecruiterGrades(db, other, [MSG]),
      await recordRecruiterGrade(db, { candidateId: other, gmailMessageId: MSG, grade: GRADE }),
    ]).toEqual([[], { ok: false, error: { kind: "UnknownMessage" } }]);
  });

  it("puts the grade id and codes in the span, never anything else", async () => {
    await recordMail(candidateId, MSG);
    exporter.reset();
    await recordRecruiterGrade(db, { candidateId, gmailMessageId: MSG, grade: GRADE });
    const span = exporter.getFinishedSpans().find((s) => s.name === "db.recruiter_grade.record");
    expect(span?.attributes["northstar.recruiter.grade"]).toBe("B");
  });
});

describe("the recruiter_grade table", () => {
  it("is append-only, and refuses text in reasons, a null reason, a bad grade or a bad Gmail id", async () => {
    await recordMail(candidateId, MSG);
    await recordRecruiterGrade(db, { candidateId, gmailMessageId: MSG, grade: GRADE });
    await recordMail(candidateId, "18c3f0a2b4d6e802");
    const row = (reasons: string[], grade = "B", gmailMessageId = "18c3f0a2b4d6e802") =>
      db.insert(recruiterGrade).values({
        candidateId,
        gmailMessageId,
        grade,
        points: 1,
        reasons,
        confidence: "normal",
      });
    expect([
      await sqlState(db.update(recruiterGrade).set({ grade: "A" })),
      await sqlState(db.delete(recruiterGrade)),
      await sqlState(db.execute(sql`truncate recruiter_grade`)),
      await sqlState(row(["Hi Paul, great role"])),
      await sqlState(
        db.execute(
          sql`insert into recruiter_grade (candidate_id, gmail_message_id, grade, points, reasons, confidence) values (${candidateId}, '18c3f0a2b4d6e802', 'B', 1, array['title:exact', null]::text[], 'normal')`,
        ),
      ),
      await sqlState(row(["title:exact"], "E")),
      await sqlState(row(["title:exact"], "B", "not-a-gmail-id")),
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
