import { type CandidateId, err, ok, type Result } from "@northstar/domain";
import { and, desc, eq, max, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import { voiceEdit, voiceProfile, voiceReview } from "./voice-schema.js";

// Paul's voice profile (NS-185, ANS-007/008): the only writer of voice_profile, voice_review and
// voice_edit. Phrases come from his writing, so events carry versions and counts only.

// What packages/profile's measureVoice produces (its VoiceProfile), by shape: this package can't
// import it.
export type VoiceMeasures = {
  samples: number;
  words: number;
  sentenceWords: number;
  contractionsPer100: number;
  iPer100: number;
  wePer100: number;
  exclamationShare: number;
  phrases: string[];
};

export type VoiceNotFound = { kind: "NotFound" };
// A review must decide every phrase of its version, once, and name no other.
export type PhrasesMismatch = { kind: "PhrasesMismatch" };

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// A phrase is 1–4 words and short: anything longer would be a sentence of Paul's writing, which
// these tables must never hold. Checked here, before any insert, so a database CHECK (whose error
// quotes the row) never has to refuse one.
const MAX_PHRASE_CHARS = 80;
export const isPhrase = (p: string): boolean => {
  const n = p.trim().split(/\s+/).filter(Boolean).length;
  return n >= 1 && n <= 4 && p.length <= MAX_PHRASE_CHARS;
};
// The most a version (measureVoice keeps 10) or an edit may hold, matching the tables' CHECKs.
const MAX_PROFILE_PHRASES = 50;
const MAX_EDIT_PHRASES = 200;

// Stores a new measured version, numbered after the candidate's newest.
export async function saveVoiceProfile(
  db: Db,
  input: { candidateId: CandidateId; measures: VoiceMeasures },
): Promise<{ version: number }> {
  const phrases = input.measures.phrases;
  if (phrases.length > MAX_PROFILE_PHRASES || !phrases.every(isPhrase)) {
    // A caller bug (measureVoice never does this); the message names no phrase.
    throw new Error("saveVoiceProfile: phrases must be at most 50 short phrases");
  }
  return inSpan("db.voice.save", {}, (span) =>
    db.transaction(async (tx) => {
      const [last] = await tx
        .select({ version: max(voiceProfile.version) })
        .from(voiceProfile)
        .where(eq(voiceProfile.candidateId, input.candidateId));
      // Two saves racing for one number: the unique key fails one, nothing doubles.
      const version = (last?.version ?? 0) + 1;
      const m = input.measures;
      const [row] = await tx
        .insert(voiceProfile)
        .values({ candidateId: input.candidateId, version, ...m })
        .returning({ id: voiceProfile.id, createdAt: voiceProfile.createdAt });
      if (!row) throw new Error("voice_profile insert returned no row");
      await appendEvent(tx, span, {
        candidateId: input.candidateId,
        aggregate: `voice_profile:${row.id}`,
        type: "voice.measured",
        actor: "user",
        reason: `Voice profile measured (version ${version}): ${m.samples} samples, ${m.phrases.length} phrase${m.phrases.length === 1 ? "" : "s"} to review`,
        payload: { version, samples: m.samples, phrases: m.phrases.length },
        idempotencyKey: `voice_profile:${row.id}`,
        at: row.createdAt,
      });
      span.setAttribute("northstar.voice.version", version);
      return { version };
    }),
  );
}

// A version's row, scoped to the candidate.
async function versionRow(tx: Tx | Db, candidateId: CandidateId, version: number) {
  const [row] = await tx
    .select()
    .from(voiceProfile)
    .where(and(eq(voiceProfile.candidateId, candidateId), eq(voiceProfile.version, version)));
  return row;
}

// Paul's keep/drop decision on one version's phrases (ANS-007). The newest review of a version
// is the one that counts.
export async function reviewVoiceProfile(
  db: Db,
  input: { candidateId: CandidateId; version: number; keep: string[]; drop: string[] },
): Promise<Result<void, VoiceNotFound | PhrasesMismatch>> {
  return inSpan("db.voice.review", {}, (span) =>
    db.transaction(async (tx): Promise<Result<void, VoiceNotFound | PhrasesMismatch>> => {
      const profile = await versionRow(tx, input.candidateId, input.version);
      if (!profile) return err({ kind: "NotFound" });
      const decided = [...input.keep, ...input.drop];
      const exact =
        decided.length === profile.phrases.length &&
        new Set(decided).size === decided.length &&
        decided.every((p) => profile.phrases.includes(p));
      if (!exact) return err({ kind: "PhrasesMismatch" });
      // Stored in the measured order (most common first), whatever order Paul gave them in.
      const kept = profile.phrases.filter((p) => input.keep.includes(p));
      const dropped = profile.phrases.filter((p) => input.drop.includes(p));
      const [row] = await tx
        .insert(voiceReview)
        .values({ candidateId: input.candidateId, profileId: profile.id, kept, dropped })
        .returning({ id: voiceReview.id, createdAt: voiceReview.createdAt });
      if (!row) throw new Error("voice_review insert returned no row");
      await appendEvent(tx, span, {
        candidateId: input.candidateId,
        aggregate: `voice_profile:${profile.id}`,
        type: "voice.reviewed",
        actor: "user",
        reason: `Voice profile reviewed (version ${input.version}): ${input.keep.length} kept, ${input.drop.length} dropped`,
        payload: { version: input.version, kept: input.keep.length, dropped: input.drop.length },
        idempotencyKey: `voice_review:${row.id}`,
        at: row.createdAt,
      });
      return ok(undefined);
    }),
  );
}

// The newest version, reviewed or not, with its phrases and whether Paul has reviewed it, or null
// before the first one (NS-222: `profile voice review` lists what to decide). Read-only.
export async function readNewestVoice(
  db: Db,
  candidateId: CandidateId,
): Promise<{ version: number; phrases: string[]; reviewed: boolean } | null> {
  const [row] = await db
    .select({ id: voiceProfile.id, version: voiceProfile.version, phrases: voiceProfile.phrases })
    .from(voiceProfile)
    .where(eq(voiceProfile.candidateId, candidateId))
    .orderBy(desc(voiceProfile.version))
    .limit(1);
  if (!row) return null;
  const [review] = await db
    .select({ id: voiceReview.id })
    .from(voiceReview)
    .where(and(eq(voiceReview.candidateId, candidateId), eq(voiceReview.profileId, row.id)))
    .limit(1);
  return { version: row.version, phrases: row.phrases, reviewed: review !== undefined };
}

// The newest version Paul has reviewed, with only the phrases he kept, or null when none is.
export async function readReviewedVoice(
  db: Db,
  candidateId: CandidateId,
): Promise<{ version: number; measures: VoiceMeasures } | null> {
  const [row] = await db
    .select({ profile: voiceProfile, kept: voiceReview.kept })
    .from(voiceReview)
    .innerJoin(
      voiceProfile,
      and(
        eq(voiceProfile.id, voiceReview.profileId),
        eq(voiceProfile.candidateId, voiceReview.candidateId),
      ),
    )
    .where(eq(voiceReview.candidateId, candidateId))
    // The newest version first, then its newest review (id breaks a tie within one instant).
    .orderBy(desc(voiceProfile.version), desc(voiceReview.createdAt), desc(sql`${voiceReview.id}`))
    .limit(1);
  if (!row) return null;
  const p = row.profile;
  return {
    version: p.version,
    measures: {
      samples: p.samples,
      words: p.words,
      sentenceWords: p.sentenceWords,
      contractionsPer100: p.contractionsPer100,
      iPer100: p.iPer100,
      wePer100: p.wePer100,
      exclamationShare: p.exclamationShare,
      phrases: row.kept,
    },
  };
}

// Stores the phrases Paul deleted from one draft before approving it (ANS-008), once per
// `subject` (what was approved, e.g. `answer:<id>`): a retried approval stores nothing new.
// Only phrase-shaped entries are kept, at most MAX_EDIT_PHRASES (a heavy rewrite can produce
// more; the first ones are plenty to learn from). An edit that deleted nothing stores nothing.
// Returns whether a row was stored.
export async function recordVoiceEdit(
  db: Db,
  input: { candidateId: CandidateId; subject: string; deleted: string[] },
): Promise<boolean> {
  const deleted = input.deleted.filter(isPhrase).slice(0, MAX_EDIT_PHRASES);
  return inSpan("db.voice.edit", { "northstar.voice.deleted": deleted.length }, async (span) => {
    if (deleted.length === 0) return false;
    const stored = await db
      .insert(voiceEdit)
      .values({ candidateId: input.candidateId, subject: input.subject, deleted })
      .onConflictDoNothing({ target: [voiceEdit.candidateId, voiceEdit.subject] })
      .returning({ id: voiceEdit.id });
    span.setAttribute("northstar.voice.stored", stored.length > 0);
    return stored.length > 0;
  });
}

// Every stored edit's deleted phrases, oldest first, for avoidedFromDeleted.
export async function readVoiceEdits(db: Db, candidateId: CandidateId): Promise<string[][]> {
  const rows = await db
    .select({ deleted: voiceEdit.deleted })
    .from(voiceEdit)
    .where(eq(voiceEdit.candidateId, candidateId))
    // Order doesn't change what's learned; the id makes it stable within one instant.
    .orderBy(voiceEdit.createdAt, voiceEdit.id);
  return rows.map((r) => r.deleted);
}
