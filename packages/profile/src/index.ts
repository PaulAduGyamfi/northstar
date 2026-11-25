// Public entry of @northstar/profile: resume import into the profile graph (NS-110, ADR-0004), the
// guided story interview (NS-111), the employment-facts consistency check (NS-112, DX-011) and the
// question canon for the answer bank (NS-118, ANS-001/002) and answer reuse (GH-59, ANS-003).
export {
  type AdaptedAnswer,
  adaptAnswer,
  narrativeKindOf,
  reuseNote,
  type StoredAnswer,
} from "./answer-bank.js";
export {
  blocksAutoSubmit,
  type Claim,
  type ClaimSource,
  checkEmploymentFacts,
  type Mismatch,
  type MismatchField,
  parseOfficialRecord,
  type RecordLineError,
} from "./facts.js";
export { type ImportDeps, type ImportResult, importResume } from "./import.js";
export {
  type Choice,
  type InterviewDeps,
  type InterviewOutcome,
  type InterviewStore,
  runInterview,
  SCRIPT,
  type Terminal,
} from "./interview.js";
export {
  CANONICAL_QUESTIONS,
  type CanonicalQuestion,
  type CanonicalQuestionId,
  FACTUAL_FIELDS,
  type FactualField,
  QUESTION_KINDS,
  type QuestionKind,
} from "./question-canon.js";
export {
  AMBIGUITY_MARGIN,
  classifyQuestion,
  FACTUAL_THRESHOLD,
  MATCH_THRESHOLD,
  matchQuestion,
  type QuestionClassification,
  type QuestionMatch,
  questionConcepts,
} from "./question-match.js";
export { PROFILE_EXTRACT_VERSION, profileExtractRoute } from "./route.js";
export { ProfileExtract } from "./schema.js";
export {
  renderAnswers,
  STORY_DRAFT_VERSION,
  type StoryDraftInput,
  storyDraftRoute,
} from "./story-route.js";
export { COMPETENCIES, STAR_PARTS, type StarPart, StoryDraft } from "./story-schema.js";
export { type StoryEvidence, type StoryFailure, validateStoryDraft } from "./story-validate.js";
export { fileToText } from "./text.js";
export {
  checkThesis,
  THESIS_MAX_LENGTH,
  type ThesisEvidence,
  type ThesisFailure,
  type ThesisRole,
  yearsOfExperience,
} from "./thesis.js";
export { normalize, type ProvenanceFailure, validateProvenance } from "./validate.js";
