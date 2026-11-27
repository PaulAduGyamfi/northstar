// Public entry of @northstar/sources (NS-114): link ingest, ATS clients, JSON-LD and the
// job-extract route, dedupe, and each source's terms status.
// Fresh-job alerts (NS-163): the plain-code decision, quiet hours and the alert pass.
export {
  type AlertConfig,
  AlertSettingError,
  type AlertStore,
  alertPass,
  decideAlert,
  type EffectiveAlertConfig,
  effectiveAlertConfig,
  FRESH_MINUTES,
  inQuietHours,
  jobTier,
  loadAlertConfig,
  parseQuietHours,
  parseTier1,
  parseTimeZone,
  scoreThenAlert,
  settingsSource,
} from "./alerts.js";
// Alert settings as `jobs alerts` checks and words them (NS-199), shared with the API.
export {
  ALERT_FIELD_WORDS,
  type AlertFieldWord,
  type AlertSettingsView,
  alertChange,
  alertReset,
  alertSettingsView,
} from "./alerts-cli.js";
export { type AtsTarget, detectAts } from "./ats/detect.js";
export { findDuplicate, type Match, nameKey, SIMILARITY, similarity } from "./dedupe.js";
export { type Extraction, emptyFields, htmlToText } from "./extraction.js";
export * from "./fetch.js";
// Career directions (NS-130 slice 2, DNA-004): role families ranked by evidence coverage.
export {
  type CareerDirection,
  careerDirections,
  type DirectionJob,
  FRESH_DIRECTION_DAYS,
  MIN_DIRECTION_JOBS,
  roleFamily,
} from "./fit/directions.js";
// Model-assisted requirement matching (NS-138): the job-match route, its provenance check and the
// assist step scorePending can take. Off by default.
export {
  type AssistResult,
  assistUnmatched,
  checkJobMatches,
  JOB_MATCH_VERSION,
  type JobMatchInput,
  JobMatchOutput,
  jobMatchInput,
  jobMatchRoute,
  type ModelMatch,
} from "./fit/model-match.js";
// One Fit Score pass (NS-116), exported for the API's capture (NS-186).
export {
  type ScoreCounts,
  type ScoreRun,
  type ScoreStore,
  scorePending,
} from "./fit/run.js";
export { type IngestDeps, type IngestResult, ingestText, ingestUrl } from "./ingest.js";
export {
  checkJobProvenance,
  type DroppedField,
  JOB_EXTRACT_VERSION,
  type JobExtractInput,
  jobExtractRoute,
  PAGE_LIMIT,
  renderPage,
} from "./job-extract-route.js";
export { JobExtract } from "./job-extract-schema.js";
export { findJobPosting, fromJsonLd } from "./jsonld.js";
// The queue's fresh-first order (SRC-013), for the jobs page (NS-130 slice 10).
export { ageHours, freshness, queueScore } from "./queue.js";
// Recruiter grading (NS-167, REC-001): A–F from the checked facts and the search preferences.
export {
  type Grade,
  type GradeReason,
  gradeRecruiterMessage,
  type RecruiterFactsInput,
  type RecruiterGrade,
} from "./recruiter/grade.js";
export { type SourceTerms, type Terms, termsFor } from "./terms.js";
