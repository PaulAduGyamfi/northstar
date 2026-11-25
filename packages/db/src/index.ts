// Public entry of @northstar/db: the schema, the status-change write path and the event reader.

export { soleCandidate } from "./candidate.js";
export { type DbConfig, loadDbConfig } from "./config.js";
export { connectDb } from "./connect.js";
export type { Db } from "./db.js";
export type { StoredEvent } from "./events.js";
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
export {
  type IdempotencyKeyReused,
  type NotFound,
  type StaleStatus,
  type TransitionError,
  type TransitionInput,
  type TransitionResult,
  transitionApplication,
} from "./transition-application.js";
