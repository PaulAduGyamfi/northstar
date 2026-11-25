import { randomUUID } from "node:crypto";
import { CandidateId, UNDO_WINDOW_MS } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bankAnswer, bankAnswerCitation, bankAnswerUse } from "./answer-schema.js";
import {
  answerContentSha256,
  readBankAnswer,
  recordAnswerReuse,
  type SaveAnswerInput,
  saveApprovedAnswer,
} from "./answer-write.js";
import { decideApprovals, requestApproval, undoDecision } from "./approval-write.js";
import type { Db } from "./db.js";
import { experienceAtom } from "./profile-schema.js";
import { writeProfileImport } from "./profile-write.js";
import { application, domainEvent, job } from "./schema.js";
import { story, storyAtom } from "./story-schema.js";
import { startInterview } from "./story-write.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

const RESTRICT_VIOLATION = "23001";
const FOREIGN_KEY_VIOLATION = "23503";
const NOW = new Date("2026-11-25T12:00:00Z");
const after = (ms: number) => new Date(NOW.getTime() + ms);

// Synthetic answer text only (public repo).
const SHORT = "I like building reliable systems at {company}.";
const LONG = "I like building reliable systems, and {company} runs the kind of platform I want.";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let applicationId: string;
let clock: Date;

async function setClock(at: Date): Promise<void> {
  clock = at;
  await db.execute(sql`select set_config('northstar.gate_test_now', ${at.toISOString()}, false)`);
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "awaiting_approval");
  candidateId = CandidateId.parse(seeded.candidateId);
  applicationId = seeded.applicationId;
  await setClock(NOW);
});

afterEach(async () => {
  await close();
});

type Draft = Pick<SaveAnswerInput, "canonicalId" | "shortText" | "longText">;
const draft = (overrides: Partial<Draft> = {}): Draft => ({
  canonicalId: "why-this-role",
  shortText: SHORT,
  longText: LONG,
  ...overrides,
});

// Asks the Gate about one answer and returns the request id.
async function requestFor(answerId: string, content: Draft, hash?: string): Promise<string> {
  const result = await requestApproval(db, {
    candidateId,
    kind: "answer",
    subject: `answer:${answerId}`,
    contentSha256: hash ?? answerContentSha256(content),
    facts: null,
    actor: "agent:answers",
    idempotencyKey: randomUUID(),
  });
  if (!result.ok) throw new Error(result.error.kind);
  return result.value.requestId;
}

async function decide(requestId: string, decision: "approve" | "reject"): Promise<string> {
  const result = await decideApprovals(db, {
    candidateId,
    requestIds: [requestId],
    decision,
    ...(decision === "reject" ? { reason: "Not my voice" } : {}),
  });
  if (!result.ok) throw new Error(result.error.kind);
  const outcome = result.value[0];
  if (!outcome?.result.ok) throw new Error("not decided");
  return outcome.result.value.decisionId;
}

const input = (
  answerId: string,
  decisionId: string,
  content: Draft,
  overrides: Partial<SaveAnswerInput> = {},
): SaveAnswerInput => ({
  candidateId,
  answerId,
  decisionId,
  applicationId,
  kind: "company_specific",
  edited: false,
  confidence: 0.86,
  storyIds: [],
  atomIds: [],
  traceId: null,
  ...content,
  ...overrides,
});

// Paul approves an answer and its undo window passes; returns what the save needs.
async function approved(
  content: Draft = draft(),
): Promise<{ answerId: string; decisionId: string }> {
  const answerId = randomUUID();
  const decisionId = await decide(await requestFor(answerId, content), "approve");
  await setClock(new Date(clock.getTime() + UNDO_WINDOW_MS));
  return { answerId, decisionId };
}

// One synthetic atom (no employer), as the resume import stores it.
async function syntheticAtom(): Promise<string> {
  await writeProfileImport(db, {
    candidateId,
    fileName: "resume.txt",
    textSha256: "c".repeat(64),
    promptVersion: 1,
    model: "claude-opus-5-5",
    traceId: null,
    call: {},
    extract: {
      roles: [],
      education: [],
      atoms: [
        {
          roleKey: null,
          what: "Synthetic achievement",
          how: [],
          impact: null,
          scope: null,
          startMonth: null,
          endMonth: null,
          sourceQuote: "Did a synthetic thing.",
          evidenceLink: null,
        },
      ],
      skills: [],
      certifications: [],
      links: [],
    },
  });
  const [atom] = await db.select({ id: experienceAtom.id }).from(experienceAtom);
  if (!atom) throw new Error("no atom");
  return atom.id;
}

// A story about a synthetic atom, still in draft.
async function draftStory(): Promise<string> {
  const atomId = await syntheticAtom();
  const { interviewId } = await startInterview(db, { candidateId, atomId, traceId: null });
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(story)
      .values({
        candidateId,
        interviewId,
        title: "Synthetic",
        situation: "s",
        task: "t",
        action: "a",
        result: "r",
        competencies: ["learning"],
        promptVersion: 1,
        model: "claude-opus-5-5",
      })
      .returning({ id: story.id });
    if (!row) throw new Error("no story");
    await tx.insert(storyAtom).values({ candidateId, storyId: row.id, atomId });
    return row.id;
  });
}

// Another application of the same candidate, for a reuse.
async function secondApplication(): Promise<string> {
  const [j] = await db
    .insert(job)
    .values({ candidateId, title: null, url: "https://jobs.example.com/second", status: "draft" })
    .returning({ id: job.id });
  if (!j) throw new Error("no job");
  const [a] = await db
    .insert(application)
    .values({ candidateId, jobId: j.id, status: "awaiting_approval" })
    .returning({ id: application.id });
  if (!a) throw new Error("no application");
  return a.id;
}

async function eventsOf(type: string) {
  return db.select().from(domainEvent).where(eq(domainEvent.type, type));
}

describe("saveApprovedAnswer", () => {
  it("stores an answer Paul approved as version 1 with its use and one event", async () => {
    const { answerId, decisionId } = await approved();
    const result = await saveApprovedAnswer(
      db,
      input(answerId, decisionId, draft(), { edited: true }),
    );
    expect(result).toEqual({ ok: true, value: { answerId, version: 1, saved: true } });
    const uses = await db.select().from(bankAnswerUse);
    expect(uses.map((u) => [u.applicationId, u.how, u.edited])).toEqual([
      [applicationId, "approved", true],
    ]);
    const [event] = await eventsOf("answer.approved");
    expect(event?.payload).toEqual({
      answerId,
      canonicalId: "why-this-role",
      kind: "company_specific",
      version: 1,
      applicationId,
      decisionId,
      edited: true,
      confidence: 0.86,
      storyCount: 0,
      atomCount: 0,
    });
  });

  it("saving the same answer twice stores one answer, one use and one event", async () => {
    const { answerId, decisionId } = await approved();
    await saveApprovedAnswer(db, input(answerId, decisionId, draft()));
    const again = await saveApprovedAnswer(db, input(answerId, decisionId, draft()));
    expect(again).toEqual({ ok: true, value: { answerId, version: 1, saved: false } });
    expect((await db.select().from(bankAnswer)).length).toBe(1);
    expect((await db.select().from(bankAnswerUse)).length).toBe(1);
    expect((await eventsOf("answer.approved")).length).toBe(1);
  });

  it("refuses an answer with no approval and stores nothing", async () => {
    const result = await saveApprovedAnswer(db, input(randomUUID(), randomUUID(), draft()));
    expect(result).toEqual({ ok: false, error: { kind: "NotFound" } });
    expect((await db.select().from(bankAnswer)).length).toBe(0);
  });

  it("refuses an answer whose text changed after Paul approved it", async () => {
    const { answerId, decisionId } = await approved();
    const changed = draft({ shortText: "Something Paul never saw." });
    const result = await saveApprovedAnswer(db, input(answerId, decisionId, changed));
    expect(result).toEqual({ ok: false, error: { kind: "ContentChanged" } });
  });

  it("refuses an approval of another answer", async () => {
    const { decisionId } = await approved();
    const result = await saveApprovedAnswer(db, input(randomUUID(), decisionId, draft()));
    expect(result).toEqual({ ok: false, error: { kind: "SubjectMismatch" } });
  });

  it("refuses an answer Paul rejected", async () => {
    const answerId = randomUUID();
    const decisionId = await decide(await requestFor(answerId, draft()), "reject");
    await setClock(after(UNDO_WINDOW_MS));
    const result = await saveApprovedAnswer(db, input(answerId, decisionId, draft()));
    expect(result).toEqual({ ok: false, error: { kind: "Rejected" } });
  });

  it("refuses an answer inside its undo window, and one whose approval was undone", async () => {
    const answerId = randomUUID();
    const decisionId = await decide(await requestFor(answerId, draft()), "approve");
    const early = await saveApprovedAnswer(db, input(answerId, decisionId, draft()));
    expect(early.ok ? "saved" : early.error.kind).toBe("UndoWindowOpen");
    const undone = await undoDecision(db, { candidateId, decisionId });
    expect(undone.ok).toBe(true);
    await setClock(after(UNDO_WINDOW_MS));
    const late = await saveApprovedAnswer(db, input(answerId, decisionId, draft()));
    expect(late).toEqual({ ok: false, error: { kind: "Undone" } });
    expect((await db.select().from(bankAnswer)).length).toBe(0);
  });

  it("refuses empty text and a malformed canonical id before asking the Gate", async () => {
    const result = await saveApprovedAnswer(
      db,
      input(randomUUID(), randomUUID(), draft({ canonicalId: "Why Us", shortText: "  " })),
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "InvalidAnswer", fields: ["canonicalId", "shortText"] },
    });
  });

  it("a second approved answer is version 2, the bank's answer, and the count covers both", async () => {
    const first = await approved();
    await saveApprovedAnswer(db, input(first.answerId, first.decisionId, draft()));
    const edited = draft({ shortText: "A shorter synthetic answer.", longText: null });
    const second = await approved(edited);
    const result = await saveApprovedAnswer(db, input(second.answerId, second.decisionId, edited));
    expect(result).toEqual({
      ok: true,
      value: { answerId: second.answerId, version: 2, saved: true },
    });
    const bank = await readBankAnswer(db, candidateId, "why-this-role");
    expect(bank).toEqual({
      answerId: second.answerId,
      canonicalId: "why-this-role",
      kind: "company_specific",
      version: 2,
      shortText: "A shorter synthetic answer.",
      longText: null,
      storyIds: [],
      atomIds: [],
      useCount: 2,
    });
  });

  it("refuses to cite a story that isn't approved", async () => {
    const storyId = await draftStory();
    const { answerId, decisionId } = await approved();
    const result = await saveApprovedAnswer(
      db,
      input(answerId, decisionId, draft(), { storyIds: [storyId] }),
    );
    expect(result).toEqual({ ok: false, error: { kind: "StoryNotApproved", storyIds: [storyId] } });
  });

  it("refuses to cite an atom that isn't this candidate's", async () => {
    const { answerId, decisionId } = await approved();
    const state = await sqlState(
      saveApprovedAnswer(db, input(answerId, decisionId, draft(), { atomIds: [randomUUID()] })),
    );
    expect(state).toBe(FOREIGN_KEY_VIOLATION);
    expect((await db.select().from(bankAnswer)).length).toBe(0);
  });
});

describe("the answer bank is append-only", () => {
  it("refuses to update or delete an answer, a citation or a use", async () => {
    const atomId = await syntheticAtom();
    const { answerId, decisionId } = await approved();
    const saved = await saveApprovedAnswer(
      db,
      input(answerId, decisionId, draft(), { atomIds: [atomId] }),
    );
    expect(saved.ok).toBe(true);
    expect(await sqlState(db.update(bankAnswer).set({ shortText: "changed" }))).toBe(
      RESTRICT_VIOLATION,
    );
    expect(await sqlState(db.delete(bankAnswer))).toBe(RESTRICT_VIOLATION);
    expect(await sqlState(db.update(bankAnswerUse).set({ edited: true }))).toBe(RESTRICT_VIOLATION);
    expect(await sqlState(db.delete(bankAnswerUse))).toBe(RESTRICT_VIOLATION);
    expect(await sqlState(db.update(bankAnswerCitation).set({ atomId: null }))).toBe(
      RESTRICT_VIOLATION,
    );
    expect(await sqlState(db.delete(bankAnswerCitation))).toBe(RESTRICT_VIOLATION);
  });
});

describe("recordAnswerReuse", () => {
  it("records a reuse once per application, with one event and no answer text", async () => {
    const { answerId, decisionId } = await approved();
    await saveApprovedAnswer(db, input(answerId, decisionId, draft()));
    const other = await seedApplication(db, "awaiting_approval");
    // The second application belongs to another candidate; reuse needs one of Paul's own.
    expect(
      await sqlState(
        recordAnswerReuse(db, {
          candidateId,
          answerId,
          applicationId: other.applicationId,
          confidence: 0.9,
          traceId: null,
        }),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);

    const secondId = await secondApplication();
    const reuse = {
      candidateId,
      answerId,
      applicationId: secondId,
      confidence: 0.9,
      traceId: null,
    };
    expect(await recordAnswerReuse(db, reuse)).toEqual({ recorded: true });
    expect(await recordAnswerReuse(db, reuse)).toEqual({ recorded: false });
    const events = await eventsOf("answer.reused");
    expect(events.map((e) => e.payload)).toEqual([
      {
        answerId,
        canonicalId: "why-this-role",
        kind: "company_specific",
        applicationId: secondId,
        confidence: 0.9,
      },
    ]);
    expect(JSON.stringify(events.map((e) => e.payload))).not.toContain("reliable systems");
    expect((await readBankAnswer(db, candidateId, "why-this-role"))?.useCount).toBe(2);
  });
});
