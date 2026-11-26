import { createHash } from "node:crypto";
import type { CandidateId } from "@northstar/domain";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { education, experienceAtom, profileSource, role, skill } from "./profile-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import { job } from "./schema.js";
import { tailoredResume } from "./tailor-schema.js";

// Tailored resumes (NS-146, TLR-001/003/005): the reader that feeds packages/profile's tailor and
// the only writer of tailored_resume. Resume lines, requirements and skills stay in the table;
// events and spans carry ids, counts and flags only.

// The master resume in the shape packages/profile's MasterResume expects (it can't be imported
// from here: profile depends on db).
export type TailorMaster = {
  roles: {
    id: string;
    employer: string;
    title: string;
    startMonth: string | null;
    endMonth: string | null;
    isCurrent: boolean;
  }[];
  education: {
    school: string;
    degree: string | null;
    field: string | null;
    endMonth: string | null;
  }[];
  atoms: { id: string; roleId: string | null; what: string; how: string[]; sourceQuote: string }[];
  skills: string[];
};
export type TailorJobView = {
  id: string;
  title: string | null;
  requirements: string[];
  niceToHaves: string[];
};
export type TailorInput = { profileSourceId: string; master: TailorMaster; job: TailorJobView };
export type TailorInputError =
  | { kind: "NoProfile" }
  | { kind: "JobNotFound" }
  | { kind: "JobNotReady" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The current resume import and a ready job of this candidate, or why not.
export async function readTailorInput(
  db: Db,
  candidateId: CandidateId,
  jobId: string,
): Promise<{ ok: true; value: TailorInput } | { ok: false; error: TailorInputError }> {
  if (!UUID.test(jobId)) return { ok: false, error: { kind: "JobNotFound" } };
  const [row] = await db
    .select({
      id: job.id,
      title: job.title,
      status: job.status,
      requirements: job.requirements,
      niceToHaves: job.niceToHaves,
    })
    .from(job)
    .where(and(eq(job.id, jobId), eq(job.candidateId, candidateId)));
  if (!row) return { ok: false, error: { kind: "JobNotFound" } };
  if (row.status !== "ready") return { ok: false, error: { kind: "JobNotReady" } };
  const [source] = await db
    .select({ id: profileSource.id })
    .from(profileSource)
    .where(
      and(
        eq(profileSource.candidateId, candidateId),
        // The resume only (NS-133): a LinkedIn import is also a current source.
        eq(profileSource.kind, "resume"),
        isNull(profileSource.supersededAt),
      ),
    );
  if (!source) return { ok: false, error: { kind: "NoProfile" } };
  const roles = await db
    .select({
      id: role.id,
      employer: role.employer,
      title: role.title,
      startMonth: role.startMonth,
      endMonth: role.endMonth,
      isCurrent: role.isCurrent,
    })
    .from(role)
    .where(eq(role.sourceId, source.id))
    .orderBy(asc(role.position));
  const schools = await db
    .select({
      school: education.school,
      degree: education.degree,
      field: education.field,
      endMonth: education.endMonth,
    })
    .from(education)
    .where(eq(education.sourceId, source.id))
    // Education has no stored order: newest first (ongoing first), then by name, so it's stable.
    .orderBy(sql`${education.endMonth} desc nulls first`, asc(education.school));
  const atoms = await db
    .select({
      id: experienceAtom.id,
      roleId: experienceAtom.roleId,
      what: experienceAtom.what,
      how: experienceAtom.how,
      sourceQuote: experienceAtom.sourceQuote,
    })
    .from(experienceAtom)
    .where(eq(experienceAtom.sourceId, source.id))
    .orderBy(asc(experienceAtom.position));
  const skills = await db
    .select({ name: skill.name })
    .from(skill)
    .where(eq(skill.sourceId, source.id))
    // Skills have no stored order: by name, so the same import always hashes the same.
    .orderBy(asc(skill.name));
  return {
    ok: true,
    value: {
      profileSourceId: source.id,
      master: { roles, education: schools, atoms, skills: skills.map((s) => s.name) },
      job: {
        id: row.id,
        title: row.title,
        requirements: row.requirements,
        niceToHaves: row.niceToHaves,
      },
    },
  };
}

// What the event reports: counts and flags computed by the caller, never text.
export type TailorSummary = {
  lines: number;
  atoms: number;
  addedSkills: number;
  droppedSkills: number;
  notClaimed: number;
  keywordsCovered: number;
  keywordsTotal: number;
  titleMatch: "exact" | "partial" | "none" | "unknown";
  atsPass: boolean;
  valid: boolean;
  failures: number;
};

export type SaveTailoredInput = {
  candidateId: CandidateId;
  jobId: string;
  profileSourceId: string;
  resume: Record<string, unknown>;
  validation: Record<string, unknown>;
  score: Record<string, unknown>;
  droppedSkills: string[];
  summary: TailorSummary;
};

// Stable JSON (sorted keys) so the same content always hashes the same.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Stores a new version for the job, or nothing when the newest version holds the same import,
// resume and toggles.
export async function saveTailoredResume(
  db: Db,
  input: SaveTailoredInput,
): Promise<{ version: number; saved: boolean }> {
  const dropped = [...new Set(input.droppedSkills.map((s) => s.toLowerCase()))].sort();
  const contentSha256 = createHash("sha256")
    // The score too: a changed job title or requirement changes it, so it isn't left stale.
    .update(
      stable({ source: input.profileSourceId, resume: input.resume, dropped, score: input.score }),
    )
    .digest("hex");
  try {
    return await inSpan(
      "resume.tailor",
      { "northstar.job.id": input.jobId, "northstar.tailor.lines": input.summary.lines },
      (span) =>
        db.transaction(async (tx) => {
          const [latest] = await tx
            .select({ version: tailoredResume.version, sha: tailoredResume.contentSha256 })
            .from(tailoredResume)
            .where(
              and(
                eq(tailoredResume.candidateId, input.candidateId),
                eq(tailoredResume.jobId, input.jobId),
              ),
            )
            .orderBy(desc(tailoredResume.version))
            .limit(1);
          if (latest?.sha === contentSha256) {
            span.setAttribute("northstar.tailor.saved", false);
            return { version: latest.version, saved: false };
          }
          // Two saves racing for one version: the unique key fails one, nothing doubles.
          const version = (latest?.version ?? 0) + 1;
          const [row] = await tx
            .insert(tailoredResume)
            .values({
              candidateId: input.candidateId,
              jobId: input.jobId,
              version,
              profileSourceId: input.profileSourceId,
              resume: input.resume,
              validation: input.validation,
              score: input.score,
              droppedSkills: dropped,
              contentSha256,
            })
            .returning({ id: tailoredResume.id, createdAt: tailoredResume.createdAt });
          if (!row) throw new Error("tailored_resume insert returned no row");
          const s = input.summary;
          await appendEvent(tx, span, {
            candidateId: input.candidateId,
            aggregate: `job:${input.jobId}`,
            type: "resume.tailored",
            actor: "user",
            // Numbers and fixed words only.
            reason: `Resume tailored (version ${version}): ${s.lines} line${s.lines === 1 ? "" : "s"}, ${s.keywordsCovered} of ${s.keywordsTotal} keywords, ${s.valid ? "every line cited" : `${s.failures} problem${s.failures === 1 ? "" : "s"} to fix`}`,
            payload: {
              tailoredResumeId: row.id,
              jobId: input.jobId,
              profileSourceId: input.profileSourceId,
              version,
              ...s,
            },
            idempotencyKey: `tailored_resume:${row.id}`,
            at: row.createdAt,
          });
          span.setAttribute("northstar.tailor.saved", true);
          return { version, saved: true };
        }),
    );
  } catch {
    // A fresh error with no cause: the driver's message lists the query's parameters (resume text).
    throw new Error("resume.tailor save failed");
  }
}

export type TailoredVersion = {
  version: number;
  profileSourceId: string;
  resume: Record<string, unknown>;
  validation: Record<string, unknown>;
  score: Record<string, unknown>;
  droppedSkills: string[];
  createdAt: Date;
};

// Every version made for a job, newest first.
export async function readTailoredResumes(
  db: Db,
  candidateId: CandidateId,
  jobId: string,
): Promise<TailoredVersion[]> {
  if (!UUID.test(jobId)) return [];
  return db
    .select({
      version: tailoredResume.version,
      profileSourceId: tailoredResume.profileSourceId,
      resume: tailoredResume.resume,
      validation: tailoredResume.validation,
      score: tailoredResume.score,
      droppedSkills: tailoredResume.droppedSkills,
      createdAt: tailoredResume.createdAt,
    })
    .from(tailoredResume)
    .where(and(eq(tailoredResume.candidateId, candidateId), eq(tailoredResume.jobId, jobId)))
    .orderBy(desc(tailoredResume.version));
}
