// Public entry of @northstar/profile: resume import into the profile graph (NS-110, ADR-0004), the
// guided story interview (NS-111), the employment-facts consistency check (NS-112, DX-011) and the
// question canon for the answer bank (NS-118, ANS-001/002) and resume tailoring (NS-117,
// TLR-001…004).
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
export {
  type AtomChange,
  applySkillToggles,
  diffResume,
  type ResumeDiff,
  type SkillChange,
} from "./tailor/diff.js";
export { HEADERS, renderResumeText } from "./tailor/render.js";
export {
  ATS_MIN_RECOVERED,
  type AtsCheck,
  atsParseCheck,
  type KeywordCoverage,
  type PreSendScore,
  preSendScore,
  type TitleMatch,
} from "./tailor/score.js";
export { DEFAULT_MAX_LINES, type TailorOptions, tailorResume } from "./tailor/tailor.js";
export {
  type Line,
  type MasterAtom,
  type MasterEducation,
  type MasterResume,
  type MasterRole,
  TailoredResume,
  type TailorJob,
} from "./tailor/types.js";
export {
  type TailorFailure,
  type TailorValidateOptions,
  type TailorValidation,
  validateTailoredResume,
} from "./tailor/validate.js";
export { fileToText } from "./text.js";
export { normalize, type ProvenanceFailure, validateProvenance } from "./validate.js";
