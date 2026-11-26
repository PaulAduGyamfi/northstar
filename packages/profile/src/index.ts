// Public entry of @northstar/profile: resume import into the profile graph (NS-110, ADR-0004), the
// guided story interview (NS-111), the employment-facts consistency check (NS-112, DX-011) and the
// question canon for the answer bank (NS-118, ANS-001/002), answer reuse (GH-59, ANS-003),
// resume tailoring (NS-117, TLR-001…004), answer drafting (NS-135, ANS-004), the voice profile
// (NS-136, ANS-007/008) and the resume audit (NS-159, AUD-001/002).

export { type DraftRequest, type DraftResult, draftAnswer } from "./answer/draft.js";
export {
  atomEvidence,
  contentWords,
  EVIDENCE_LIMIT,
  type EvidenceItem,
  selectEvidence,
  storyEvidence,
} from "./answer/evidence.js";
export {
  ANSWER_DRAFT_VERSION,
  type AnswerDraftInput,
  answerDraftRoute,
  renderEvidence,
} from "./answer/route.js";
export { AnswerDraft } from "./answer/schema.js";
export {
  type AnswerFailure,
  type AnswerValidation,
  answerText,
  validateAnswerDraft,
} from "./answer/validate.js";
export {
  type AdaptedAnswer,
  adaptAnswer,
  narrativeKindOf,
  reuseNote,
  type StoredAnswer,
} from "./answer-bank.js";
export { type ApplyRefusal, type ApplyResult, applySuggestion } from "./audit/apply.js";
export {
  type AuditDimension,
  auditResume,
  fullResume,
  LONG_LINE,
  type ResumeAudit,
  type Suggestion,
  type SuggestionKind,
  type SuggestionTarget,
} from "./audit/audit.js";
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
// Factual answers from Paul's settings (NS-141), used by package assembly (NS-161).
export { answerFactual, type FactualAnswer, type Setting } from "./factual.js";
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
export { renderResumeDocx } from "./tailor/docx.js";
export { type FittedResume, preSendScoreFromPdf, tailorToPages } from "./tailor/fit.js";
export {
  checkModelResume,
  type ModelTailorResult,
  resumeTailorInput,
  tailorWithModel,
} from "./tailor/model-tailor.js";
export { type RenderedPdf, renderResumePdf } from "./tailor/pdf.js";
export { HEADERS, renderResumeText } from "./tailor/render.js";
export {
  RESUME_TAILOR_VERSION,
  type ResumeTailorInput,
  renderJob,
  renderProfile,
  resumeTailorRoute,
} from "./tailor/route.js";
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
export { fileToText, pdfToText } from "./text.js";
export {
  checkThesis,
  THESIS_MAX_LENGTH,
  type ThesisEvidence,
  type ThesisFailure,
  type ThesisRole,
  yearsOfExperience,
} from "./thesis.js";
export {
  type DraftedThesis,
  draftTheses,
  MAX_CANDIDATES,
  POSITIONING_THESIS_VERSION,
  positioningThesisRoute,
  renderThesisProfile,
  ThesisCandidates,
  type ThesisDraftResult,
  thesisEvidence,
  thesisProblems,
} from "./thesis-draft.js";
export { normalize, type ProvenanceFailure, validateProvenance } from "./validate.js";
export {
  AVOID_AFTER,
  avoidedFromDeleted,
  avoidedPhrases,
  deletedPhrases,
  type Edit,
  findAvoided,
} from "./voice/edits.js";
export {
  MAX_SAMPLES,
  type MeasureResult,
  MIN_SAMPLES,
  measureVoice,
  PHRASE_SAMPLES,
  renderVoiceGuide,
  type VoiceProfile,
} from "./voice/measure.js";
export { loadVoice, recordEdit, type StoredVoice } from "./voice/store.js";
