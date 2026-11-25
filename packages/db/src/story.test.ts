import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { experienceAtom } from "./profile-schema.js";
import { type ProfileImportInput, writeProfileImport } from "./profile-write.js";
import { candidate, domainEvent } from "./schema.js";
import { story, storyAnswer, storyAtom, storyInterview } from "./story-schema.js";
import {
  type ApprovedStoryInput,
  abandonInterview,
  nextAtomForInterview,
  readInterviewAnswers,
  readStories,
  recordAnswer,
  recordDraftOutcome,
  saveApprovedStory,
  startInterview,
} from "./story-write.js";
import { createTestDb, sqlState } from "./test/pglite.js";

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

async function newCandidate(): Promise<CandidateId> {
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  return CandidateId.parse(c.id);
}

// A synthetic atom (invented employer), as the resume import stores it.
const atom = (n: number): ProfileImportInput["extract"]["atoms"][number] => ({
  roleKey: "r1",
  what: `Synthetic achievement ${n}`,
  how: [],
  impact: null,
  scope: null,
  startMonth: null,
  endMonth: null,
  sourceQuote: `Did synthetic thing number ${n}.`,
  evidenceLink: null,
});

async function importAtoms(owner: CandidateId, count: number, sha = "a"): Promise<string[]> {
  await writeProfileImport(db, {
    candidateId: owner,
    fileName: "resume.txt",
    textSha256: sha.repeat(64),
    promptVersion: 1,
    model: "claude-opus-5-5",
    traceId: null,
    call: {},
    extract: {
      roles: [
        {
          key: "r1",
          employer: "Example Logistics",
          title: "Engineer",
          startMonth: "2020",
          endMonth: null,
          current: true,
        },
      ],
      education: [],
      atoms: Array.from({ length: count }, (_, i) => atom(i)),
      skills: [],
      certifications: [],
      links: [],
    },
  });
  const rows = await db
    .select({ id: experienceAtom.id, position: experienceAtom.position })
    .from(experienceAtom)
    .where(eq(experienceAtom.candidateId, owner))
    .orderBy(sql`${experienceAtom.createdAt} desc, ${experienceAtom.position}`);
  return rows.slice(0, count).map((r) => r.id);
}

const approved = (interviewId: string, atomIds: string[]): ApprovedStoryInput => ({
  candidateId,
  interviewId,
  story: {
    title: "Rerouting the night shift",
    situation: "Deliveries were late.",
    task: "I owned the routing job.",
    action: "I rewrote it.",
    result: "Late deliveries dropped.",
    competencies: ["ownership"],
  },
  atomIds,
  promptVersion: 1,
  model: "claude-opus-5-5",
  traceId: null,
});

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = await newCandidate();
});

afterEach(async () => {
  await close();
});

describe("startInterview", () => {
  it("opens one interview per atom and returns it again on a rerun", async () => {
    const [atomId = ""] = await importAtoms(candidateId, 1);
    const first = await startInterview(db, { candidateId, atomId, traceId: null });
    const second = await startInterview(db, { candidateId, atomId, traceId: null });
    expect(second).toEqual({ interviewId: first.interviewId, resumed: true });
    const events = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "story.interview_started"));
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ interviewId: first.interviewId, atomId });
  });

  it("refuses an interview about another candidate's atom", async () => {
    const other = await newCandidate();
    const [foreignAtom = ""] = await importAtoms(other, 1);
    const code = await sqlState(
      startInterview(db, { candidateId, atomId: foreignAtom, traceId: null }),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe("recordAnswer", () => {
  it("recording the same answer twice writes one row and one event", async () => {
    const [atomId = ""] = await importAtoms(candidateId, 1);
    const { interviewId } = await startInterview(db, { candidateId, atomId, traceId: null });
    const answer = {
      candidateId,
      interviewId,
      position: 0,
      question: "Q",
      answer: "A",
      traceId: null,
    };
    expect(await recordAnswer(db, answer)).toEqual({ recorded: true });
    expect(await recordAnswer(db, { ...answer, answer: "A different answer" })).toEqual({
      recorded: false,
    });
    expect(await readInterviewAnswers(db, candidateId, interviewId)).toEqual([
      { position: 0, question: "Q", answer: "A" },
    ]);
    const events = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "story.answer_recorded"));
    expect(events).toHaveLength(1);
  });

  it("puts the position in the event and never the answer text", async () => {
    const [atomId = ""] = await importAtoms(candidateId, 1);
    const { interviewId } = await startInterview(db, { candidateId, atomId, traceId: null });
    await recordAnswer(db, {
      candidateId,
      interviewId,
      position: 2,
      question: "What did you do?",
      answer: "I paired with the dispatch lead every morning",
      traceId: null,
    });
    const [event] = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "story.answer_recorded"));
    expect(event?.payload).toEqual({ interviewId, position: 2 });
    expect(JSON.stringify({ ...event, position: null })).not.toContain("dispatch lead");
  });
});

describe("saveApprovedStory", () => {
  it("stores the approved story with its atoms and marks the interview drafted", async () => {
    const [atomId = ""] = await importAtoms(candidateId, 1);
    const { interviewId } = await startInterview(db, { candidateId, atomId, traceId: null });
    const storyId = await saveApprovedStory(db, approved(interviewId, [atomId]));
    const [row] = await db.select().from(story).where(eq(story.id, storyId));
    expect(row?.status).toBe("approved");
    expect(row?.approvedAt).toBeInstanceOf(Date);
    expect(await db.select().from(storyAtom)).toEqual([{ candidateId, storyId, atomId }]);
    const [interview] = await db.select().from(storyInterview);
    expect(interview?.status).toBe("drafted");
    const [event] = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "story.approved"));
    expect(event?.payload).toEqual({
      storyId,
      interviewId,
      atomIds: [atomId],
      competencies: ["ownership"],
      promptVersion: 1,
      model: "claude-opus-5-5",
    });
    expect(JSON.stringify({ ...event, position: null })).not.toContain("night shift");
  });

  it("refuses a story with no atom", async () => {
    const [atomId = ""] = await importAtoms(candidateId, 1);
    const { interviewId } = await startInterview(db, { candidateId, atomId, traceId: null });
    await expect(saveApprovedStory(db, approved(interviewId, []))).rejects.toThrow(
      "a story must cite at least one atom",
    );
  });

  it("the database refuses a story row that no atom link follows", async () => {
    const [atomId = ""] = await importAtoms(candidateId, 1);
    const { interviewId } = await startInterview(db, { candidateId, atomId, traceId: null });
    const { story: parts } = approved(interviewId, [atomId]);
    const code = await sqlState(
      db.insert(story).values({ candidateId, interviewId, ...parts, promptVersion: 1, model: "m" }),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it("refuses a competency outside the list", async () => {
    const [atomId = ""] = await importAtoms(candidateId, 1);
    const { interviewId } = await startInterview(db, { candidateId, atomId, traceId: null });
    const input = approved(interviewId, [atomId]);
    const bad = { ...input, story: { ...input.story, competencies: ["charisma"] } };
    const code = await sqlState(saveApprovedStory(db, bad as unknown as ApprovedStoryInput));
    expect(code).toBe(CHECK_VIOLATION);
  });

  it("refuses more than three competencies", async () => {
    const [atomId = ""] = await importAtoms(candidateId, 1);
    const { interviewId } = await startInterview(db, { candidateId, atomId, traceId: null });
    const input = approved(interviewId, [atomId]);
    const many: ApprovedStoryInput = {
      ...input,
      story: { ...input.story, competencies: ["ownership", "scale", "learning", "conflict"] },
    };
    expect(await sqlState(saveApprovedStory(db, many))).toBe(CHECK_VIOLATION);
  });

  it("stores a repeated competency once", async () => {
    const [atomId = ""] = await importAtoms(candidateId, 1);
    const { interviewId } = await startInterview(db, { candidateId, atomId, traceId: null });
    const input = approved(interviewId, [atomId]);
    const storyId = await saveApprovedStory(db, {
      ...input,
      story: { ...input.story, competencies: ["scale", "scale", "ownership"] },
    });
    const [row] = await db.select().from(story).where(eq(story.id, storyId));
    expect(row?.competencies).toEqual(["scale", "ownership"]);
  });

  it("refuses a story that cites another candidate's atom", async () => {
    const [atomId = ""] = await importAtoms(candidateId, 1);
    const other = await newCandidate();
    const [foreignAtom = ""] = await importAtoms(other, 1, "b");
    const { interviewId } = await startInterview(db, { candidateId, atomId, traceId: null });
    const code = await sqlState(saveApprovedStory(db, approved(interviewId, [foreignAtom])));
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe("approved stories are locked", () => {
  async function approvedStory(): Promise<{ storyId: string; atomIds: string[] }> {
    const atomIds = await importAtoms(candidateId, 2);
    const [atomId = ""] = atomIds;
    const { interviewId } = await startInterview(db, { candidateId, atomId, traceId: null });
    return { storyId: await saveApprovedStory(db, approved(interviewId, [atomId])), atomIds };
  }

  it("changing an approved story's text is refused by the database", async () => {
    const { storyId } = await approvedStory();
    const code = await sqlState(
      db
        .update(story)
        .set({ result: "Late deliveries dropped by 90%." })
        .where(eq(story.id, storyId)),
    );
    expect(code).toBe(RESTRICT_VIOLATION);
  });

  it("deleting an approved story is refused", async () => {
    const { storyId } = await approvedStory();
    expect(await sqlState(db.delete(story).where(eq(story.id, storyId)))).toBe(RESTRICT_VIOLATION);
  });

  it("adding or removing an approved story's atoms is refused", async () => {
    const { storyId, atomIds } = await approvedStory();
    const added = await sqlState(
      db.insert(storyAtom).values({ candidateId, storyId, atomId: atomIds[1] ?? "" }),
    );
    expect(added).toBe(RESTRICT_VIOLATION);
    expect(await sqlState(db.delete(storyAtom))).toBe(RESTRICT_VIOLATION);
  });
});

describe("abandonInterview", () => {
  it("abandons an open interview once, keeping its answers", async () => {
    const [atomId = ""] = await importAtoms(candidateId, 1);
    const { interviewId } = await startInterview(db, { candidateId, atomId, traceId: null });
    await recordAnswer(db, {
      candidateId,
      interviewId,
      position: 0,
      question: "Q",
      answer: "A",
      traceId: null,
    });
    await abandonInterview(db, { candidateId, interviewId, traceId: null });
    await abandonInterview(db, { candidateId, interviewId, traceId: null });
    const [interview] = await db.select().from(storyInterview);
    expect(interview?.status).toBe("abandoned");
    expect(await db.select().from(storyAnswer)).toHaveLength(1);
    const events = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "story.interview_abandoned"));
    expect(events).toHaveLength(1);
  });
});

describe("recordDraftOutcome", () => {
  it("appends story.rejected with the reason and failure count only", async () => {
    const [atomId = ""] = await importAtoms(candidateId, 1);
    const { interviewId } = await startInterview(db, { candidateId, atomId, traceId: null });
    await recordDraftOutcome(db, {
      candidateId,
      interviewId,
      round: 1,
      outcome: "rejected",
      reason: "provenance",
      failureCount: 2,
      call: { outputTokens: 400 },
      traceId: null,
    });
    const [event] = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "story.rejected"));
    expect(event?.payload).toEqual({
      interviewId,
      round: 1,
      reason: "provenance",
      failureCount: 2,
      call: { outputTokens: 400 },
    });
  });
});

describe("nextAtomForInterview", () => {
  it("offers atoms in resume order, skipping told and skipped ones", async () => {
    const [a0 = "", a1 = "", a2 = ""] = await importAtoms(candidateId, 3);
    expect((await nextAtomForInterview(db, candidateId))?.id).toBe(a0);

    const first = await startInterview(db, { candidateId, atomId: a0, traceId: null });
    await saveApprovedStory(db, approved(first.interviewId, [a0]));
    expect((await nextAtomForInterview(db, candidateId))?.id).toBe(a1);

    const second = await startInterview(db, { candidateId, atomId: a1, traceId: null });
    await abandonInterview(db, { candidateId, interviewId: second.interviewId, traceId: null });
    expect(await nextAtomForInterview(db, candidateId)).toMatchObject({
      id: a2,
      what: "Synthetic achievement 2",
      sourceQuote: "Did synthetic thing number 2.",
      employer: "Example Logistics",
      title: "Engineer",
    });
  });

  it("offers an atom with an open interview first, so a rerun resumes it", async () => {
    const [, a1 = ""] = await importAtoms(candidateId, 2);
    await startInterview(db, { candidateId, atomId: a1, traceId: null });
    expect((await nextAtomForInterview(db, candidateId))?.id).toBe(a1);
  });

  it("only offers atoms of the current resume source", async () => {
    await importAtoms(candidateId, 1, "a");
    const [fresh = ""] = await importAtoms(candidateId, 1, "b");
    expect((await nextAtomForInterview(db, candidateId))?.id).toBe(fresh);
  });

  it("returns the atom asked for, and null for another candidate's atom", async () => {
    const [, a1 = ""] = await importAtoms(candidateId, 2);
    expect((await nextAtomForInterview(db, candidateId, a1))?.id).toBe(a1);
    const other = await newCandidate();
    const [foreignAtom = ""] = await importAtoms(other, 1, "c");
    expect(await nextAtomForInterview(db, candidateId, foreignAtom)).toBeNull();
  });
});

describe("readStories", () => {
  it("lists approved stories with their atoms", async () => {
    const [atomId = ""] = await importAtoms(candidateId, 1);
    const { interviewId } = await startInterview(db, { candidateId, atomId, traceId: null });
    const storyId = await saveApprovedStory(db, approved(interviewId, [atomId]));
    expect(await readStories(db, candidateId)).toEqual([
      {
        id: storyId,
        title: "Rerouting the night shift",
        situation: "Deliveries were late.",
        task: "I owned the routing job.",
        action: "I rewrote it.",
        result: "Late deliveries dropped.",
        competencies: ["ownership"],
        atomIds: [atomId],
      },
    ]);
  });
});
