import { randomUUID } from "node:crypto";
import type { CandidateId } from "@northstar/domain";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { experienceAtom, profileSource, role } from "./profile-schema.js";
import { domainEvent } from "./schema.js";
import { type Competency, story, storyAnswer, storyAtom, storyInterview } from "./story-schema.js";

// The story bank's only write paths (CPG-003, NS-111). Each change and its domain event are
// written in one transaction (ADR-0012). Events carry ids, positions and counts, never Paul's
// answers or story text (OBS-001).

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type EventInput = {
  candidateId: CandidateId;
  aggregate: string;
  type: string;
  actor: "user" | "system" | `agent:${string}`;
  reason: string;
  payload: Record<string, unknown>;
  traceId: string | null;
  idempotencyKey: string;
};

async function appendEvent(tx: Tx, e: EventInput): Promise<void> {
  await tx.insert(domainEvent).values({
    id: randomUUID(),
    candidateId: e.candidateId,
    aggregate: e.aggregate,
    type: e.type,
    actor: e.actor,
    reason: e.reason,
    inputsSummary: "",
    payload: e.payload,
    links: [],
    traceId: e.traceId,
    idempotencyKey: e.idempotencyKey,
    occurredAt: new Date(),
  });
}

// What the interview shows Paul about one atom: his own resume line, and its role if any.
export type AtomView = {
  id: string;
  what: string;
  sourceQuote: string;
  employer: string | null;
  title: string | null;
};

export type InterviewAnswer = { position: number; question: string; answer: string };

// Opens an interview about one atom, or returns the open one so a rerun resumes it.
export async function startInterview(
  db: Db,
  input: { candidateId: CandidateId; atomId: string; traceId: string | null },
): Promise<{ interviewId: string; resumed: boolean }> {
  return db.transaction(async (tx) => {
    const [open] = await tx
      .select({ id: storyInterview.id })
      .from(storyInterview)
      .where(
        and(
          eq(storyInterview.candidateId, input.candidateId),
          eq(storyInterview.atomId, input.atomId),
          eq(storyInterview.status, "open"),
        ),
      );
    if (open) return { interviewId: open.id, resumed: true };
    const [row] = await tx
      .insert(storyInterview)
      .values({ candidateId: input.candidateId, atomId: input.atomId })
      .returning({ id: storyInterview.id });
    if (!row) throw new Error("story_interview insert returned no row");
    await appendEvent(tx, {
      candidateId: input.candidateId,
      aggregate: `story_interview:${row.id}`,
      type: "story.interview_started",
      actor: "user",
      reason: "Story interview started",
      payload: { interviewId: row.id, atomId: input.atomId },
      traceId: input.traceId,
      idempotencyKey: `story-interview:${row.id}:started`,
    });
    return { interviewId: row.id, resumed: false };
  });
}

// Saves one answer as soon as Paul gives it. The same position twice is a no-op (RES-006): the
// first answer stays, and only that one gets an event.
export async function recordAnswer(
  db: Db,
  input: {
    candidateId: CandidateId;
    interviewId: string;
    position: number;
    question: string;
    answer: string;
    traceId: string | null;
  },
): Promise<{ recorded: boolean }> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(storyAnswer)
      .values({
        candidateId: input.candidateId,
        interviewId: input.interviewId,
        position: input.position,
        question: input.question,
        answer: input.answer,
      })
      .onConflictDoNothing({ target: [storyAnswer.interviewId, storyAnswer.position] })
      .returning({ id: storyAnswer.id });
    if (inserted.length === 0) return { recorded: false };
    await appendEvent(tx, {
      candidateId: input.candidateId,
      aggregate: `story_interview:${input.interviewId}`,
      type: "story.answer_recorded",
      actor: "user",
      reason: "Story interview answer saved",
      // The position only: the answer is Paul's own words and stays in story_answer.
      payload: { interviewId: input.interviewId, position: input.position },
      traceId: input.traceId,
      idempotencyKey: `story-answer:${input.interviewId}:${input.position}`,
    });
    return { recorded: true };
  });
}

// The interview's answers so far, in order.
export async function readInterviewAnswers(
  db: Db,
  candidateId: CandidateId,
  interviewId: string,
): Promise<InterviewAnswer[]> {
  return db
    .select({
      position: storyAnswer.position,
      question: storyAnswer.question,
      answer: storyAnswer.answer,
    })
    .from(storyAnswer)
    .where(and(eq(storyAnswer.candidateId, candidateId), eq(storyAnswer.interviewId, interviewId)))
    .orderBy(asc(storyAnswer.position));
}

// Records what one story-draft call produced: a draft Paul can review (`drafted`), or a draft the
// provenance check or the model outcome ruled out (`rejected`). Counts and the call record only.
export async function recordDraftOutcome(
  db: Db,
  input: {
    candidateId: CandidateId;
    interviewId: string;
    round: number;
    outcome: "drafted" | "rejected";
    // For `rejected`: the model outcome kind, or `provenance` with the number of failures.
    reason: string | null;
    failureCount: number;
    call: Record<string, unknown>;
    traceId: string | null;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await appendEvent(tx, {
      candidateId: input.candidateId,
      aggregate: `story_interview:${input.interviewId}`,
      type: input.outcome === "drafted" ? "story.drafted" : "story.rejected",
      actor: "agent:story-draft",
      reason:
        input.outcome === "drafted"
          ? "Story drafted from interview answers"
          : "Story draft rejected before review",
      payload: {
        interviewId: input.interviewId,
        round: input.round,
        reason: input.reason,
        failureCount: input.failureCount,
        call: input.call,
      },
      traceId: input.traceId,
      // Each call is its own event; a retry of the same call never reaches here twice.
      idempotencyKey: `story-draft:${input.interviewId}:${randomUUID()}`,
    });
  });
}

export type ApprovedStoryInput = {
  candidateId: CandidateId;
  interviewId: string;
  story: {
    title: string;
    situation: string;
    task: string;
    action: string;
    result: string;
    competencies: Competency[];
  };
  atomIds: string[];
  promptVersion: number;
  model: string;
  traceId: string | null;
};

// Stores the story Paul approved: written as a draft, its atom links added, then approved, which
// locks it (migration 0010). The interview is marked drafted. One story.approved event.
export async function saveApprovedStory(db: Db, input: ApprovedStoryInput): Promise<string> {
  const atomIds = [...new Set(input.atomIds)];
  if (atomIds.length === 0) throw new Error("a story must cite at least one atom");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(story)
      .values({
        candidateId: input.candidateId,
        interviewId: input.interviewId,
        ...input.story,
        // A repeated tag is one tag (the CHECK counts entries, not distinct ones).
        competencies: [...new Set(input.story.competencies)],
        promptVersion: input.promptVersion,
        model: input.model,
      })
      .returning({ id: story.id });
    if (!row) throw new Error("story insert returned no row");
    await tx
      .insert(storyAtom)
      .values(
        atomIds.map((atomId) => ({ candidateId: input.candidateId, storyId: row.id, atomId })),
      );
    await tx
      .update(story)
      .set({ status: "approved", approvedAt: sql`now()` })
      .where(eq(story.id, row.id));
    const marked = await tx
      .update(storyInterview)
      .set({ status: "drafted" })
      .where(
        and(
          eq(storyInterview.id, input.interviewId),
          eq(storyInterview.candidateId, input.candidateId),
          eq(storyInterview.status, "open"),
        ),
      )
      .returning({ id: storyInterview.id });
    if (marked.length === 0) throw new Error("the interview is not open");
    await appendEvent(tx, {
      candidateId: input.candidateId,
      aggregate: `story:${row.id}`,
      type: "story.approved",
      actor: "user",
      reason: "Paul approved a story for the story bank",
      payload: {
        storyId: row.id,
        interviewId: input.interviewId,
        atomIds,
        competencies: [...new Set(input.story.competencies)],
        promptVersion: input.promptVersion,
        model: input.model,
      },
      traceId: input.traceId,
      idempotencyKey: `story-approved:${row.id}`,
    });
    return row.id;
  });
}

// Paul skipped this atom. The answers stay; the picker won't offer the atom again.
export async function abandonInterview(
  db: Db,
  input: { candidateId: CandidateId; interviewId: string; traceId: string | null },
): Promise<void> {
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(storyInterview)
      .set({ status: "abandoned" })
      .where(
        and(
          eq(storyInterview.id, input.interviewId),
          eq(storyInterview.candidateId, input.candidateId),
          eq(storyInterview.status, "open"),
        ),
      )
      .returning({ id: storyInterview.id });
    // Already abandoned or drafted: nothing to do, and no second event.
    if (updated.length === 0) return;
    await appendEvent(tx, {
      candidateId: input.candidateId,
      aggregate: `story_interview:${input.interviewId}`,
      type: "story.interview_abandoned",
      actor: "user",
      reason: "Paul skipped this atom",
      payload: { interviewId: input.interviewId },
      traceId: input.traceId,
      idempotencyKey: `story-interview:${input.interviewId}:abandoned`,
    });
  });
}

// The atom to interview about: the one asked for, or else an atom of the current resume source
// with an open interview (resume it), or else the first one in resume order that has never been
// approved into a story or skipped. Null when every atom is done.
export async function nextAtomForInterview(
  db: Db,
  candidateId: CandidateId,
  atomId?: string,
): Promise<AtomView | null> {
  const select = db
    .select({
      id: experienceAtom.id,
      what: experienceAtom.what,
      sourceQuote: experienceAtom.sourceQuote,
      employer: role.employer,
      title: role.title,
      position: experienceAtom.position,
    })
    .from(experienceAtom)
    .leftJoin(role, eq(role.id, experienceAtom.roleId));

  if (atomId !== undefined) {
    // A resume atom only (NS-133): a LinkedIn export's atoms aren't interviewed yet.
    const [row] = await select
      .innerJoin(profileSource, eq(profileSource.id, experienceAtom.sourceId))
      .where(
        and(
          eq(experienceAtom.candidateId, candidateId),
          eq(experienceAtom.id, atomId),
          eq(profileSource.kind, "resume"),
        ),
      );
    return row ? toAtomView(row) : null;
  }

  const atoms = await select
    .innerJoin(profileSource, eq(profileSource.id, experienceAtom.sourceId))
    .where(
      and(
        eq(experienceAtom.candidateId, candidateId),
        eq(profileSource.kind, "resume"),
        isNull(profileSource.supersededAt),
      ),
    )
    .orderBy(asc(experienceAtom.position));
  if (atoms.length === 0) return null;

  const ids = atoms.map((a) => a.id);
  const interviews = await db
    .select({ atomId: storyInterview.atomId, status: storyInterview.status })
    .from(storyInterview)
    .where(and(eq(storyInterview.candidateId, candidateId), inArray(storyInterview.atomId, ids)));
  const told = await db
    .select({ atomId: storyAtom.atomId })
    .from(storyAtom)
    .innerJoin(story, eq(story.id, storyAtom.storyId))
    .where(
      and(
        eq(storyAtom.candidateId, candidateId),
        eq(story.status, "approved"),
        inArray(storyAtom.atomId, ids),
      ),
    );

  const open = new Set(interviews.filter((i) => i.status === "open").map((i) => i.atomId));
  const done = new Set([
    ...interviews.filter((i) => i.status !== "open").map((i) => i.atomId),
    ...told.map((t) => t.atomId),
  ]);
  const next = atoms.find((a) => open.has(a.id)) ?? atoms.find((a) => !done.has(a.id));
  return next ? toAtomView(next) : null;
}

function toAtomView(row: {
  id: string;
  what: string;
  sourceQuote: string;
  employer: string | null;
  title: string | null;
}): AtomView {
  return {
    id: row.id,
    what: row.what,
    sourceQuote: row.sourceQuote,
    employer: row.employer,
    title: row.title,
  };
}

export type StoryView = {
  id: string;
  title: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  competencies: string[];
  atomIds: string[];
};

// Every approved story, oldest first, for `profile stories`.
export async function readStories(db: Db, candidateId: CandidateId): Promise<StoryView[]> {
  const rows = await db
    .select()
    .from(story)
    .where(and(eq(story.candidateId, candidateId), eq(story.status, "approved")))
    .orderBy(asc(story.approvedAt));
  if (rows.length === 0) return [];
  const links = await db
    .select({ storyId: storyAtom.storyId, atomId: storyAtom.atomId })
    .from(storyAtom)
    .where(
      and(
        eq(storyAtom.candidateId, candidateId),
        inArray(
          storyAtom.storyId,
          rows.map((r) => r.id),
        ),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    situation: r.situation,
    task: r.task,
    action: r.action,
    result: r.result,
    competencies: r.competencies,
    atomIds: links.filter((l) => l.storyId === r.id).map((l) => l.atomId),
  }));
}
