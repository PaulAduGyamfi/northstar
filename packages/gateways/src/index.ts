// Public entry of @northstar/gateways (NS-120): the Apply Gateway, its ATS adapters and the
// browser driver contract. The only package that may act under Paul's name (ADR-0002).
export { type AtsAdapter, adapterFor, hostAllowed } from "./apply/adapters/index.js";
export type { Challenge, Fill, FormDriver, FormField, PageState, Upload } from "./apply/driver.js";
export { type FieldPlan, type MapError, mapPackage } from "./apply/map.js";
export { type ApplyPorts, dbPorts, dbSweepPorts, dbVaultPorts } from "./apply/ports.js";
export { type SweepPorts, sweepStaleClaims } from "./apply/stale.js";
export {
  ApplyInvariantError,
  CLOSE_TIMEOUT_MS,
  type FileChanged,
  type HeldBack,
  type HostNotAllowed,
  type InProgress,
  NotApprovedError,
  OPEN_TIMEOUT_MS,
  type PostingClosed,
  type PostingMismatch,
  SUBMIT_TIMEOUT_MS,
  type SubmitInput,
  type SubmitOutcome,
  type SubmitRefusal,
  submitApplication,
} from "./apply/submit.js";
// The credential vault (NS-122, ADR-0010): loading the master key, generating and storing tenant
// passwords. Opening (decrypting) is deliberately not exported: only code inside this package
// may call src/vault/open.ts (CRD-002), and a test enforces it.
export { loadVaultKey, type MasterKey } from "./vault/key.js";
// The one opening exported (NS-182, ADR-0024): Paul's own reveal, through a one-time
// `vault_reveal` the database makes and uses in one transaction. Only the API may call it.
export {
  dbRevealPorts,
  type RevealError,
  type RevealPorts,
  revealTenantPassword,
} from "./vault/reveal.js";
export { VaultSecret } from "./vault/secret.js";
export {
  generateTenantPassword,
  type StorePorts,
  storeTenantPassword,
  TENANT_PASSWORD_LENGTH,
} from "./vault/store.js";
