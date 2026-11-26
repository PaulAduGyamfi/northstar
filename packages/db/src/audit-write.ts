import type { CandidateId } from "@northstar/domain";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  atomLineEdit,
  resumeAudit,
  resumeAuditDecision,
  resumeAuditSuggestion,
} from "./audit-schema.js";
import type { Db } from "./db.js";
import { searchPreference } from "./fit-schema.js";
import { experienceAtom, profileSource } from "./profile-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import { job } from "./schema.js";
import { readResumeMaster, type TailorMaster } from "./tailor-write.js";

// Resume audits (NS-190, AUD-001/002): the reader that feeds packages/profile's auditResume, and
// the only writer of resume_audit, its suggestions, Paul's decisions and his edited lines.
// Lines, messages and targets stay in the tables; events and spans carry ids, counts, the
// suggestion's kind and the decision only.

export type AuditInput = {
  profileSourceId: string;
  // Each atom's line is Paul's newest accepted edit, else the imported quote.
  master: TailorMaster;
  // The newest search preference's titles, then every ready job's requirements, once each.
  targets: string[];
};

// The current resume import and the targets to audit it against, or null with no import.
export async function readAuditInput(db: Db, candidateId: CandidateId): Promise<AuditInput | null> {
  const current = await readResumeMaster(db, candidateId);
  if (!current) return null;
  const [pref] = await db
    .select({ titles: searchPreference.titles })
    .from(searchPreference)
    .where(eq(searchPreference.candidateId, candidateId))
    .orderBy(desc(searchPreference.version))
    .limit(1);
  const jobs = await db
    .select({ requirements: job.requirements })
    .from(job)
    .where(and(eq(job.candidateId, candidateId), eq(job.status, "ready")))
    // Oldest first, so the same jobs always give the same target order.
    .orderBy(job.createdAt, job.id);
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const t of [...(pref?.titles ?? []), ...jobs.flatMap((j) => j.requirements)]) {
    const key = t.trim().toLowerCase();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    targets.push(t.trim());
  }
  return { ...current, targets };
}

// One suggestion as auditResume returns it (packages/profile), stored under its key.
export type StoredSuggestion = {
  id: string;
  kind: string;
  dimension: string;
  target: Record<string, unknown>;
  message: string;
};

export type SaveAuditInput = {
  candidateId: CandidateId;
  profileSourceId: string;
  targets: string[];
  scores: Record<string, number>;
  overall: number;
  pages: number;
  suggestions: StoredSuggestion[];
};

// Stores a run and its suggestions in one transaction, with a `resume.audited` event.
export async function saveResumeAudit(db: Db, input: SaveAuditInput): Promise<{ auditId: string }> {
  try {
    return await inSpan(
      "resume.audit",
      { "northstar.audit.suggestions": input.suggestions.length },
      (span) =>
        db.transaction(async (tx) => {
          const [row] = await tx
            .insert(resumeAudit)
            .values({
              candidateId: input.candidateId,
              profileSourceId: input.profileSourceId,
              targets: input.targets,
              scores: input.scores,
              overall: input.overall,
              pages: input.pages,
            })
            .returning({ id: resumeAudit.id, createdAt: resumeAudit.createdAt });
          if (!row) throw new Error("resume_audit insert returned no row");
          if (input.suggestions.length > 0) {
            await tx.insert(resumeAuditSuggestion).values(
              input.suggestions.map((s, position) => ({
                candidateId: input.candidateId,
                auditId: row.id,
                key: s.id,
                kind: s.kind,
                dimension: s.dimension,
                target: s.target,
                message: s.message,
                position,
              })),
            );
          }
          const n = input.suggestions.length;
          await appendEvent(tx, span, {
            candidateId: input.candidateId,
            aggregate: `resume_audit:${row.id}`,
            type: "resume.audited",
            actor: "user",
            // Numbers and fixed words only.
            reason: `Audited your resume: ${input.overall} overall, ${n} suggestion${n === 1 ? "" : "s"}`,
            payload: {
              auditId: row.id,
              profileSourceId: input.profileSourceId,
              overall: input.overall,
              suggestions: n,
              targets: input.targets.length,
            },
            idempotencyKey: `resume_audit:${row.id}`,
            at: row.createdAt,
          });
          return { auditId: row.id };
        }),
    );
  } catch {
    // A fresh error with no cause: the driver's message lists the query's parameters (resume text).
    throw new Error("resume.audit save failed");
  }
}

// The suggestion keys Paul rejected on this import, so a re-run leaves them out.
export async function rejectedKeys(
  db: Db,
  candidateId: CandidateId,
  profileSourceId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ key: resumeAuditDecision.key })
    .from(resumeAuditDecision)
    .innerJoin(resumeAudit, eq(resumeAudit.id, resumeAuditDecision.auditId))
    .where(
      and(
        eq(resumeAuditDecision.candidateId, candidateId),
        eq(resumeAuditDecision.decision, "rejected"),
        eq(resumeAudit.profileSourceId, profileSourceId),
      ),
    );
  return new Set(rows.map((r) => r.key));
}

export type AuditView = {
  auditId: string;
  profileSourceId: string;
  targets: string[];
  scores: Record<string, number>;
  overall: number;
  pages: number;
  createdAt: Date;
  suggestions: (StoredSuggestion & {
    decision: "accepted" | "rejected" | null;
    newLine: string | null;
  })[];
};

// The newest run with its suggestions (in stored order) and any decisions, or null.
export async function readLatestAudit(db: Db, candidateId: CandidateId): Promise<AuditView | null> {
  const [run] = await db
    .select()
    .from(resumeAudit)
    .where(eq(resumeAudit.candidateId, candidateId))
    .orderBy(desc(resumeAudit.createdAt), desc(resumeAudit.id))
    .limit(1);
  if (!run) return null;
  const rows = await db
    .select({
      key: resumeAuditSuggestion.key,
      kind: resumeAuditSuggestion.kind,
      dimension: resumeAuditSuggestion.dimension,
      target: resumeAuditSuggestion.target,
      message: resumeAuditSuggestion.message,
      decision: resumeAuditDecision.decision,
      newLine: resumeAuditDecision.newLine,
    })
    .from(resumeAuditSuggestion)
    .leftJoin(
      resumeAuditDecision,
      and(
        eq(resumeAuditDecision.auditId, resumeAuditSuggestion.auditId),
        eq(resumeAuditDecision.key, resumeAuditSuggestion.key),
      ),
    )
    .where(eq(resumeAuditSuggestion.auditId, run.id))
    .orderBy(resumeAuditSuggestion.position);
  return {
    auditId: run.id,
    profileSourceId: run.profileSourceId,
    targets: run.targets,
    scores: run.scores,
    overall: run.overall,
    pages: run.pages,
    createdAt: run.createdAt,
    suggestions: rows.map((r) => ({
      id: r.key,
      kind: r.kind,
      dimension: r.dimension,
      target: r.target,
      message: r.message,
      decision: r.decision as "accepted" | "rejected" | null,
      newLine: r.newLine,
    })),
  };
}

export type AuditDecideInput =
  | { candidateId: CandidateId; auditId: string; key: string; decision: "rejected" }
  | {
      candidateId: CandidateId;
      auditId: string;
      key: string;
      decision: "accepted";
      newLine: string;
    };

export type AuditDecideError =
  | { kind: "UnknownSuggestion" }
  | { kind: "AlreadyDecided" }
  // The audit read an import that has since been superseded: its atoms aren't the current ones.
  | { kind: "StaleAudit" }
  // Only a suggestion about one atom's line can be accepted with a new line.
  | { kind: "NotALine" }
  | { kind: "EmptyLine" };

const UNIQUE_VIOLATION = "23505";

// Stores Paul's decision on one suggestion of one run, once. An acceptance also stores his line
// as the atom's newest edit, in the same transaction.
export async function decideSuggestion(
  db: Db,
  input: AuditDecideInput,
): Promise<{ ok: true; value: { decisionId: string } } | { ok: false; error: AuditDecideError }> {
  if (input.decision === "accepted" && input.newLine.trim() === "") {
    return { ok: false, error: { kind: "EmptyLine" } };
  }
  try {
    return await inSpan(
      "resume.audit_decide",
      { "northstar.audit.decision": input.decision },
      (span) =>
        db.transaction(async (tx) => {
          const [s] = await tx
            .select({
              kind: resumeAuditSuggestion.kind,
              target: resumeAuditSuggestion.target,
              superseded: profileSource.supersededAt,
            })
            .from(resumeAuditSuggestion)
            .innerJoin(resumeAudit, eq(resumeAudit.id, resumeAuditSuggestion.auditId))
            .innerJoin(profileSource, eq(profileSource.id, resumeAudit.profileSourceId))
            .where(
              and(
                eq(resumeAuditSuggestion.candidateId, input.candidateId),
                eq(resumeAuditSuggestion.auditId, input.auditId),
                eq(resumeAuditSuggestion.key, input.key),
              ),
            );
          if (!s) return { ok: false as const, error: { kind: "UnknownSuggestion" as const } };
          if (s.superseded !== null) {
            return { ok: false as const, error: { kind: "StaleAudit" as const } };
          }
          const atomId = typeof s.target.atomId === "string" ? s.target.atomId : null;
          if (input.decision === "accepted" && atomId === null) {
            return { ok: false as const, error: { kind: "NotALine" as const } };
          }
          const [already] = await tx
            .select({ id: resumeAuditDecision.id })
            .from(resumeAuditDecision)
            .where(
              and(
                eq(resumeAuditDecision.auditId, input.auditId),
                eq(resumeAuditDecision.key, input.key),
              ),
            );
          if (already) return { ok: false as const, error: { kind: "AlreadyDecided" as const } };
          const newLine = input.decision === "accepted" ? input.newLine.trim() : null;
          const [row] = await tx
            .insert(resumeAuditDecision)
            .values({
              candidateId: input.candidateId,
              auditId: input.auditId,
              key: input.key,
              decision: input.decision,
              newLine,
            })
            .returning({ id: resumeAuditDecision.id, decidedAt: resumeAuditDecision.decidedAt });
          if (!row) throw new Error("resume_audit_decision insert returned no row");
          if (newLine !== null && atomId !== null) {
            // The atom must be of this import (the same-candidate key checks the candidate).
            const [atom] = await tx
              .select({ id: experienceAtom.id })
              .from(experienceAtom)
              .innerJoin(resumeAudit, eq(resumeAudit.profileSourceId, experienceAtom.sourceId))
              .where(and(eq(experienceAtom.id, atomId), eq(resumeAudit.id, input.auditId)));
            if (!atom) throw new Error("audit suggestion names an atom outside its import");
            await tx.insert(atomLineEdit).values({
              candidateId: input.candidateId,
              atomId,
              decisionId: row.id,
              line: newLine,
            });
          }
          await appendEvent(tx, span, {
            candidateId: input.candidateId,
            aggregate: `resume_audit:${input.auditId}`,
            type: "resume.suggestion_decided",
            actor: "user",
            // Fixed words only: never the line, the message or the key (it can hold a term).
            reason:
              input.decision === "accepted"
                ? "You accepted a resume suggestion with your own line"
                : "You rejected a resume suggestion",
            payload: {
              auditId: input.auditId,
              decisionId: row.id,
              kind: s.kind,
              decision: input.decision,
            },
            idempotencyKey: `resume_audit_decision:${row.id}`,
            at: row.decidedAt,
          });
          return { ok: true as const, value: { decisionId: row.id } };
        }),
    );
  } catch (error) {
    // Two decisions racing on one suggestion: the unique key refuses the second.
    const code = (error as { cause?: { code?: unknown } }).cause?.code;
    if (code === UNIQUE_VIOLATION) return { ok: false, error: { kind: "AlreadyDecided" } };
    // A fresh error with no cause: the driver's message lists the query's parameters (the line).
    throw new Error("resume.audit decision failed");
  }
}

// Every edit of the import's atoms, newest first, for showing where a line came from.
export async function readAtomLineEdits(
  db: Db,
  candidateId: CandidateId,
): Promise<{ atomId: string; line: string; decisionId: string; createdAt: Date }[]> {
  return db
    .select({
      atomId: atomLineEdit.atomId,
      line: atomLineEdit.line,
      decisionId: atomLineEdit.decisionId,
      createdAt: atomLineEdit.createdAt,
    })
    .from(atomLineEdit)
    .innerJoin(experienceAtom, eq(experienceAtom.id, atomLineEdit.atomId))
    .innerJoin(profileSource, eq(profileSource.id, experienceAtom.sourceId))
    .where(and(eq(atomLineEdit.candidateId, candidateId), isNull(profileSource.supersededAt)))
    .orderBy(desc(atomLineEdit.createdAt), desc(atomLineEdit.id));
}
