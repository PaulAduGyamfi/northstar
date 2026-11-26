import { type Db, readReviewedVoice, readVoiceEdits, recordVoiceEdit } from "@northstar/db";
import type { CandidateId } from "@northstar/domain";
import { avoidedFromDeleted, deletedPhrases } from "./edits.js";
import { renderVoiceGuide } from "./measure.js";

// The stored voice profile and edit history, ready for draftAnswer (NS-185, ANS-007/008).

export type StoredVoice = {
  // renderVoiceGuide of the newest reviewed profile (only the phrases Paul kept), or null before
  // he has reviewed one.
  guide: string | null;
  // Phrases he deleted from AVOID_AFTER or more drafts, for draftAnswer's `avoid`.
  avoid: string[];
};

export async function loadVoice(db: Db, candidateId: CandidateId): Promise<StoredVoice> {
  const [voice, edits] = await Promise.all([
    readReviewedVoice(db, candidateId),
    readVoiceEdits(db, candidateId),
  ]);
  return {
    guide: voice ? renderVoiceGuide(voice.measures) : null,
    avoid: avoidedFromDeleted(edits),
  };
}

// Paul approved an answer that may differ from its draft: keep only what he deleted (ANS-008).
// `subject` names the approval (e.g. `answer:<id>`), so recording it again stores nothing new.
export async function recordEdit(
  db: Db,
  candidateId: CandidateId,
  subject: string,
  edit: { draft: string; approved: string },
): Promise<boolean> {
  return recordVoiceEdit(db, {
    candidateId,
    subject,
    deleted: deletedPhrases(edit.draft, edit.approved),
  });
}
