// Public entry of @northstar/db: the schema, the status-change write path and the event reader.

export * as applySchema from "./apply-schema.js";
export {
  type ClaimError,
  type Claimed,
  type ClaimInput,
  claimSubmission,
  DEFAULT_DAILY_CAP,
  DEFAULT_MIN_GAP_MS,
  type Existing,
  type NotInProgress,
  type ProofInput,
  type ProofView,
  recordNeedsHuman,
  recordSubmitted,
  type SubmissionView,
} from "./apply-write.js";
export * as approvalSchema from "./approval-schema.js";
export {
  type AlreadyDecided,
  type AlreadyUndone,
  type BatchOutcome,
  type ContentChanged,
  type DecideError,
  type DecisionView,
  decideApprovals,
  type InvalidRequest,
  listPendingApprovals,
  type PendingApproval,
  type ReasonRequired,
  type Rejected,
  type RequestError,
  type RequestResult,
  readApprovalPolicies,
  requestApproval,
  type SubjectAlreadyRequested,
  type SubjectMismatch,
  type SubjectReopened,
  setApprovalPolicies,
  type UndoError,
  type Undone,
  type UndoWindowClosed,
  type UndoWindowOpen,
  undoDecision,
  type VerifiedApproval,
  type VerifyError,
  verifyApproval,
} from "./approval-write.js";
export { soleCandidate } from "./candidate.js";
export { type DbConfig, loadDbConfig } from "./config.js";
export { connectDb } from "./connect.js";
export type { Db } from "./db.js";
export type { StoredEvent } from "./events.js";
export {
  type OfficialPosition,
  readEmploymentFacts,
  recordFactsCheck,
  type SetFactsResult,
  setEmploymentFacts,
} from "./facts-write.js";
export * as funnelSchema from "./funnel-schema.js";
export {
  type Channel,
  type FunnelMessageInput,
  type FunnelMessageRow,
  type FunnelOutcome,
  type FunnelStage,
  knownGmailIds,
  latestFactsCheck,
  type MailKind,
  type ManualRowInput,
  type ReviewDecision,
  type ReviewError,
  type ReviewReason,
  readFunnelMessages,
  readManualRows,
  recordFunnelEvent,
  resolveReview,
  type StageSignal,
  saveFunnelMessages,
  setManualRows,
} from "./funnel-write.js";
export {
  type Ats,
  type DedupeCandidate,
  type JobFields,
  type JobListItem,
  type JobSourceInput,
  listJobs,
  readDedupeCandidates,
  type SaveResult,
  type SetFieldError,
  type SourceMethod,
  saveIngestedJob,
  setJobField,
} from "./job-write.js";
export * as profileSchema from "./profile-schema.js";
export {
  currentResumeHash,
  type EditLockedFactError,
  type EditLockedFactInput,
  editLockedFact,
  type ImportReport,
  type ProfileCounts,
  type ProfileImportInput,
  type ProfileView,
  readProfile,
  writeProfileImport,
} from "./profile-write.js";
export { readEventsAfter } from "./read-events.js";
export * as schema from "./schema.js";
export * as storySchema from "./story-schema.js";
export { COMPETENCIES, type Competency } from "./story-schema.js";
export {
  type ApprovedStoryInput,
  type AtomView,
  abandonInterview,
  type InterviewAnswer,
  nextAtomForInterview,
  readInterviewAnswers,
  readStories,
  recordAnswer,
  recordDraftOutcome,
  type StoryView,
  saveApprovedStory,
  startInterview,
} from "./story-write.js";
export {
  type IdempotencyKeyReused,
  type NotFound,
  type StaleStatus,
  type TransitionError,
  type TransitionInput,
  type TransitionResult,
  transitionApplication,
} from "./transition-application.js";
export {
  addWatch,
  dueWatches,
  listWatches,
  type NextState,
  type PollResult,
  removeWatch,
  retryWatch,
  savePollResult,
  type Watch,
  type WatchAts,
  type WatchInput,
  type WatchStatus,
} from "./watch-write.js";
