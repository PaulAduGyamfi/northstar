// Public entry of @northstar/gateways (NS-120): the Apply Gateway, its ATS adapters and the
// browser driver contract. The only package that may act under Paul's name (ADR-0002).
export { type AtsAdapter, adapterFor, hostAllowed } from "./apply/adapters/index.js";
export type { Challenge, Fill, FormDriver, FormField, PageState, Upload } from "./apply/driver.js";
export { type FieldPlan, type MapError, mapPackage } from "./apply/map.js";
export { type ApplyPorts, dbPorts } from "./apply/ports.js";
export {
  ApplyInvariantError,
  CLOSE_TIMEOUT_MS,
  type FileChanged,
  type HostNotAllowed,
  type InProgress,
  NotApprovedError,
  OPEN_TIMEOUT_MS,
  type PostingMismatch,
  SUBMIT_TIMEOUT_MS,
  type SubmitInput,
  type SubmitOutcome,
  type SubmitRefusal,
  submitApplication,
} from "./apply/submit.js";
