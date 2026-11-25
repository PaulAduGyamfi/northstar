import { randomUUID } from "node:crypto";
import type { CandidateId } from "@northstar/domain";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "./db.js";
import { type FIT_BANDS, fitScore, searchPreference } from "./fit-schema.js";
import { experienceAtom, profileSource, skill } from "./profile-schema.js";
import { domainEvent, job } from "./schema.js";

// The write path for search preferences and fit scores (NS-116). packages/sources decides what a
// preference value means and how a job scores; this module only stores versions and scores, each
// with its event in the same transaction.

export type FitBand = (typeof FIT_BANDS)[number];
export type RemoteKind = "onsite" | "hybrid" | "remote";

export type PreferenceValues = {
  titles: string[];
  seniority: string[];
  locations: string[];
  remote: RemoteKind[];
  dealbreakers: string[];
  compFloor: number | null;
  compTarget: number | null;
  currency: string;
  queueAt: number;
  suggestAt: number;
};

export type Preferences = PreferenceValues & { id: string; version: number };

// What scoring uses before Paul sets anything: nothing targeted, the MAT-003 default thresholds.
export const PREFERENCE_DEFAULTS: PreferenceValues = {
  titles: [],
  seniority: [],
  locations: [],
  remote: [],
  dealbreakers: [],
  compFloor: null,
  compTarget: null,
  currency: "USD",
  queueAt: 80,
  suggestAt: 60,
};

const KEYS = Object.keys(PREFERENCE_DEFAULTS) as (keyof PreferenceValues)[];

const toPreferences = (r: typeof searchPreference.$inferSelect): Preferences => ({
  id: r.id,
  version: r.version,
  titles: r.titles,
  seniority: r.seniority,
  locations: r.locations,
  remote: r.remote as RemoteKind[],
  dealbreakers: r.dealbreakers,
  compFloor: r.compFloor,
  compTarget: r.compTarget,
  currency: r.currency,
  queueAt: r.queueAt,
  suggestAt: r.suggestAt,
});

// The current preferences (the highest version), or null before Paul sets any.
export async function readPreferences(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
): Promise<Preferences | null> {
  const [row] = await db
    .select()
    .from(searchPreference)
    .where(eq(searchPreference.candidateId, candidateId))
    .orderBy(desc(searchPreference.version))
    .limit(1);
  return row ? toPreferences(row) : null;
}

export type SavePreferencesResult =
  | { status: "unchanged"; current: Preferences | null }
  | { status: "saved"; previous: Preferences | null; current: Preferences; changed: string[] };

// Stores `values` as the next version when it differs from the current one, with a
// `preferences.changed` event naming the changed fields (never their values: the feed reads the
// two versions). Two changes racing for the same version: the unique key fails the second.
export async function savePreferences(
  db: Db,
  input: { candidateId: CandidateId; values: PreferenceValues; now: Date },
): Promise<SavePreferencesResult> {
  return db.transaction(async (tx) => {
    const previous = await readPreferences(tx, input.candidateId);
    const base = previous ?? PREFERENCE_DEFAULTS;
    const changed = KEYS.filter((k) => JSON.stringify(base[k]) !== JSON.stringify(input.values[k]));
    // The first save always stores a version, even of the defaults: scores need one to name.
    if (previous && changed.length === 0) return { status: "unchanged", current: previous };
    const version = (previous?.version ?? 0) + 1;
    const [row] = await tx
      .insert(searchPreference)
      .values({ candidateId: input.candidateId, version, ...input.values })
      .returning();
    if (!row) throw new Error("search_preference insert returned no row");
    const current = toPreferences(row);
    await tx.insert(domainEvent).values({
      id: randomUUID(),
      candidateId: input.candidateId,
      aggregate: `search_preference:${current.id}`,
      type: "preferences.changed",
      actor: "user",
      reason: "Search preferences changed",
      inputsSummary: "",
      payload: { fields: changed, fromVersion: previous?.version ?? null, toVersion: version },
      links: [],
      traceId: null,
      idempotencyKey: `preferences.changed:${current.id}`,
      occurredAt: input.now,
    });
    return { status: "saved", previous, current, changed };
  });
}

export type ScoringAtom = { id: string; what: string; how: string[] };
export type ScoringProfile = { sourceId: string; atoms: ScoringAtom[]; skills: string[] };

// The current resume import's atoms (resume order) and skills, or null before any import.
// Held in memory for scoring only; nothing from it is stored but atom ids, matched terms and,
// for a model match (NS-138), the short verbatim quote from the atom that checked out.
export async function readScoringProfile(
  db: Db,
  candidateId: CandidateId,
): Promise<ScoringProfile | null> {
  const [source] = await db
    .select({ id: profileSource.id })
    .from(profileSource)
    .where(
      and(
        eq(profileSource.candidateId, candidateId),
        eq(profileSource.kind, "resume"),
        isNull(profileSource.supersededAt),
      ),
    );
  if (!source) return null;
  const atoms = await db
    .select({ id: experienceAtom.id, what: experienceAtom.what, how: experienceAtom.how })
    .from(experienceAtom)
    .where(eq(experienceAtom.sourceId, source.id))
    .orderBy(experienceAtom.position);
  const skills = await db
    .select({ name: skill.name })
    .from(skill)
    .where(eq(skill.sourceId, source.id));
  return { sourceId: source.id, atoms, skills: skills.map((s) => s.name) };
}

// The fields scoring reads from a job.
export type ScorableJob = {
  id: string;
  title: string | null;
  location: string | null;
  remote: RemoteKind | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: "year" | "month" | "hour" | null;
  seniority: string | null;
  requirements: string[];
  niceToHaves: string[];
  description: string | null;
};

// Every ready job (drafts lack a title or company and aren't scored), oldest first.
export async function readScorableJobs(db: Db, candidateId: CandidateId): Promise<ScorableJob[]> {
  const rows = await db
    .select({
      id: job.id,
      title: job.title,
      location: job.location,
      remote: job.remote,
      salaryMin: job.salaryMin,
      salaryMax: job.salaryMax,
      salaryCurrency: job.salaryCurrency,
      salaryPeriod: job.salaryPeriod,
      seniority: job.seniority,
      requirements: job.requirements,
      niceToHaves: job.niceToHaves,
      description: job.description,
    })
    .from(job)
    .where(and(eq(job.candidateId, candidateId), eq(job.status, "ready")))
    .orderBy(job.firstSeenAt);
  return rows.map((r) => ({
    ...r,
    remote: r.remote as ScorableJob["remote"],
    salaryPeriod: r.salaryPeriod as ScorableJob["salaryPeriod"],
  }));
}

// `<jobId>:<fingerprint>` of every score already stored for this preference version and resume
// import: scoring skips those (they'd be identical).
export async function readScoreKeys(
  db: Db,
  input: { candidateId: CandidateId; preferenceId: string; profileSourceId: string },
): Promise<Set<string>> {
  const rows = await db
    .select({ jobId: fitScore.jobId, fingerprint: fitScore.jobFingerprint })
    .from(fitScore)
    .where(
      and(
        eq(fitScore.candidateId, input.candidateId),
        eq(fitScore.preferenceId, input.preferenceId),
        eq(fitScore.profileSourceId, input.profileSourceId),
      ),
    );
  return new Set(rows.map((r) => `${r.jobId}:${r.fingerprint}`));
}

export type FitScoreInput = {
  jobId: string;
  preferenceId: string;
  preferenceVersion: number;
  profileSourceId: string;
  jobFingerprint: string;
  score: number;
  band: FitBand;
  reason: string;
  stretch: boolean;
  components: Record<string, number | null>;
  evidence: Record<string, unknown>;
  // rules: plain-code matching only (NS-116); rules_model: some requirement was matched by the
  // job-match route after its provenance check (NS-138). Defaults to rules.
  method?: FitMethod;
};

export const FIT_METHODS = ["rules", "rules_model"] as const;
export type FitMethod = (typeof FIT_METHODS)[number];

// Stores one score and its `job.scored` event in one transaction. The same key twice stores
// nothing the second time ("exists").
export async function saveFitScore(
  db: Db,
  input: FitScoreInput & { candidateId: CandidateId; now: Date },
): Promise<"saved" | "exists"> {
  return db.transaction(async (tx) => {
    const { candidateId, now, preferenceVersion, method = "rules", ...row } = input;
    const [saved] = await tx
      .insert(fitScore)
      .values({ candidateId, ...row, method, scoredAt: now })
      .onConflictDoNothing({
        target: [
          fitScore.candidateId,
          fitScore.jobId,
          fitScore.preferenceId,
          fitScore.profileSourceId,
          fitScore.jobFingerprint,
        ],
      })
      .returning({ id: fitScore.id });
    if (!saved) return "exists";
    await tx.insert(domainEvent).values({
      id: randomUUID(),
      candidateId,
      aggregate: `job:${input.jobId}`,
      type: "job.scored",
      actor: "system",
      reason: input.band === "skip" ? `Skipped: ${input.reason}` : `Fit ${input.score}`,
      inputsSummary: "",
      // Numbers, codes and versions only: never a title, requirement, atom text or preference.
      payload: {
        fitScoreId: saved.id,
        score: input.score,
        band: input.band,
        reason: input.reason,
        stretch: input.stretch,
        preferenceVersion,
        method,
      },
      links: [],
      traceId: null,
      idempotencyKey: `job.scored:${saved.id}`,
      occurredAt: now,
    });
    return "saved";
  });
}

export type RescoreCounts = { jobs: number; queue: number; suggest: number; skip: number };

// After a preference change: how many jobs the new version re-scored (SRC-017's feed line).
// A report, not a side effect, so its key is unique per call. It can undercount when a
// `jobs run` tick scored some of the same jobs first (those count there, not here).
export async function recordRescore(
  db: Db,
  input: { candidateId: CandidateId; preference: Preferences; counts: RescoreCounts; now: Date },
): Promise<void> {
  await db.insert(domainEvent).values({
    id: randomUUID(),
    candidateId: input.candidateId,
    aggregate: `search_preference:${input.preference.id}`,
    type: "preferences.rescored",
    actor: "system",
    reason: `${input.counts.jobs} jobs re-scored`,
    inputsSummary: "",
    payload: { version: input.preference.version, ...input.counts },
    links: [],
    traceId: null,
    idempotencyKey: `preferences.rescored:${input.preference.id}:${randomUUID()}`,
    occurredAt: input.now,
  });
}

export type FitScoreView = {
  score: number;
  band: FitBand;
  reason: string;
  stretch: boolean;
  components: Record<string, number | null>;
  evidence: Record<string, unknown>;
  preferenceVersion: number;
  scoredAt: Date;
};

// A job's latest score, with the preference version it used (for `jobs why`).
export async function readFitScore(
  db: Db,
  input: { candidateId: CandidateId; jobId: string },
): Promise<FitScoreView | null> {
  const [row] = await db
    .select({
      score: fitScore.score,
      band: fitScore.band,
      reason: fitScore.reason,
      stretch: fitScore.stretch,
      components: fitScore.components,
      evidence: fitScore.evidence,
      preferenceVersion: searchPreference.version,
      scoredAt: fitScore.scoredAt,
    })
    .from(fitScore)
    .innerJoin(searchPreference, eq(searchPreference.id, fitScore.preferenceId))
    .where(and(eq(fitScore.candidateId, input.candidateId), eq(fitScore.jobId, input.jobId)))
    .orderBy(desc(fitScore.scoredAt), desc(searchPreference.version))
    .limit(1);
  return row ? { ...row, band: row.band as FitBand } : null;
}

// Atom texts by id, for showing the evidence to Paul (`jobs why`). Read at display time; never
// copied into scores or events.
export async function readAtomTexts(
  db: Db,
  input: { candidateId: CandidateId; ids: string[] },
): Promise<Map<string, string>> {
  if (input.ids.length === 0) return new Map();
  const rows = await db
    .select({ id: experienceAtom.id, what: experienceAtom.what })
    .from(experienceAtom)
    .where(
      and(eq(experienceAtom.candidateId, input.candidateId), inArray(experienceAtom.id, input.ids)),
    );
  return new Map(rows.map((r) => [r.id, r.what]));
}
