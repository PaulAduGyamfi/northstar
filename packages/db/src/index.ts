// Public entry of @northstar/db: the schema, the status-change write path and the event reader.

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
