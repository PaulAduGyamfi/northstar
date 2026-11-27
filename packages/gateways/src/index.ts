// Public entry of @northstar/gateways (NS-120): the Apply Gateway, its ATS adapters and the
// browser driver contract. The only package that may act under Paul's name (ADR-0002).
export { type AtsAdapter, adapterFor, hostAllowed } from "./apply/adapters/index.js";
export { deferredFormDriver, type LaunchDriver } from "./apply/browser/deferred.js";
// The Playwright form driver (NS-142, ADR-0028): the worker starts one per submission.
export {
  createPlaywrightDriver,
  DriverError,
  type DriverOptions,
  type DriverPage,
} from "./apply/browser/driver.js";
export {
  type BrowserLauncher,
  type LaunchOptions,
  launchFormDriver,
} from "./apply/browser/launch.js";
export type { Challenge, Fill, FormDriver, FormField, PageState, Upload } from "./apply/driver.js";
export { type FieldPlan, type MapError, mapPackage } from "./apply/map.js";
export {
  type ApplyPorts,
  type ApplyStep,
  dbPorts,
  dbSweepPorts,
  dbVaultPorts,
} from "./apply/ports.js";
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
// The Mail Gateway's draft writer (NS-237 slice 4, ADR-0025): an approved reply becomes a Gmail
// draft, never sent. Only the entry point, its token type and its errors are exported; the Gmail
// requests (src/mail/drafts.ts) stay inside src/mail/ (a boundary test).
export { GMAIL_COMPOSE_SCOPE, GmailComposeAccess } from "./mail/access.js";
// The draft writer's own consent flow (NS-237 slice 5): gmail.compose only, in memory for one run.
export {
  authorizeCompose,
  type ComposeConsentDeps,
  ComposeConsentError,
} from "./mail/consent.js";
export {
  type DraftGuard,
  DraftHeldBack,
  DraftInputError,
  DraftRequestError,
  DraftWriteError,
} from "./mail/errors.js";
export {
  type DraftClaim,
  type DraftRefusal,
  type DraftWritten,
  type MailPorts,
  type WriteDraftInput,
  writeReplyDraft,
} from "./mail/gateway.js";
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
