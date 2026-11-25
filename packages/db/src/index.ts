// Public entry of @northstar/db: the schema, the status-change write path and the event reader.

export * as answerSchema from "./answer-schema.js";
export { BANK_KINDS, type BankKind } from "./answer-schema.js";
export {
  type AlreadySaved,
  type AnswerContent,
  answerContentSha256,
  type BankAnswerView,
  type DecidedByPolicy,
  type InvalidAnswer,
  readBankAnswer,
  recordAnswerReuse,
  type SaveAnswerError,
  type SaveAnswerInput,
  type StoryNotApproved,
  saveApprovedAnswer,
} from "./answer-write.js";
export {
  type ApplyLimits,
  checkApplyLimits,
  DEFAULT_APPLY_LIMITS,
  loadApplyLimits,
} from "./apply-config.js";
export * as applySchema from "./apply-schema.js";
export {
  type AtsBusy,
  CLAIM_STALE_AFTER_MS,
  type ClaimError,
  type Claimed,
  type ClaimInput,
  claimSubmission,
  DEFAULT_DAILY_CAP,
  DEFAULT_MIN_GAP_MS,
  type Existing,
  listStaleClaims,
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
export {
  acquireCall,
  type BreakerView,
  readBreakers,
  recordCallOutcome,
} from "./breaker-write.js";
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
export { type FeedItem, MAX_FEED_PAGE, readFeed } from "./feed-read.js";
export * as fitSchema from "./fit-schema.js";
export {
  FIT_METHODS,
  type FitBand,
  type FitMethod,
  type FitScoreInput,
  type FitScoreView,
  PREFERENCE_DEFAULTS,
  type Preferences,
  type PreferenceValues,
  type RemoteKind,
  type RescoreCounts,
  readAtomTexts,
  readFitScore,
  readPreferences,
  readScorableJobs,
  readScoreKeys,
  readScoringProfile,
  recordRescore,
  type SavePreferencesResult,
  type ScorableJob,
  type ScoringAtom,
  type ScoringProfile,
  saveFitScore,
  savePreferences,
} from "./fit-write.js";
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
export { readSystemHealth } from "./health-read.js";
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
export {
  isSubsystemOn,
  type KillSwitchView,
  readKillSwitches,
  type SetKillSwitchResult,
  setKillSwitch,
} from "./kill-switch-write.js";
export * as mailLinkSchema from "./mail-link-schema.js";
export {
  assignTag,
  type LinkDecision,
  listConfirmQueue,
  type QueuedMail,
  type RecordLinkInput,
  readLinkedThreads,
  readTags,
  recordMailLink,
  type TagTarget,
  type TagView,
} from "./mail-link-write.js";
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
export * as resilienceSchema from "./resilience-schema.js";
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
export * as thesisSchema from "./thesis-schema.js";
export {
  readCurrentThesis,
  readThesisHistory,
  type SaveThesisResult,
  saveApprovedThesis,
  type ThesisView,
} from "./thesis-write.js";
export {
  type IdempotencyKeyReused,
  type NotFound,
  type StaleStatus,
  type TransitionError,
  type TransitionInput,
  type TransitionResult,
  transitionApplication,
} from "./transition-application.js";
// Only the audit table is exported: sealed rows are read only through openSealedSecret, so code
// outside this package can't fetch them without an audit row and the kill-switch check.
export { vaultAccess } from "./vault-schema.js";
export {
  type InvalidVaultInput,
  type NotApproved,
  type OpenInput,
  openSealedSecret,
  type SealedSecret,
  type SealedVersion,
  type SecretNotFound,
  storeSealedSecret,
  VAULT_SUBSYSTEM,
  type VaultLocked,
} from "./vault-write.js";
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
