// Public entry of @northstar/inbox (NS-113, ADR-0014): read-only Gmail access, the job-mail
// pre-filter and the mail-classify route. Since NS-123 also the Verification Catcher's core.

export { classifyByRules, type RuleResult } from "./classify-rules.js";
export { type GoogleConfig, loadGoogleConfig } from "./config.js";
export {
  createGmailClient,
  type FullMessage,
  type GmailClient,
  type GmailDeps,
  GmailError,
  type MessageHeaders,
  senderDomain,
} from "./gmail.js";
// Linking job mail to applications (NS-158): tags and the deterministic matcher.
export {
  type LinkCandidate,
  type MatchResult,
  type MatchStep,
  matchMail,
  type QueueReason,
  type TagRow,
} from "./link/match.js";
export {
  type DeliveredTag,
  generateTag,
  TAG_LENGTH,
  TAG_PATTERN,
  tagFromDeliveredTo,
  taggedAddress,
} from "./link/tag.js";
export {
  BODY_LIMIT,
  MAIL_CLASSIFY_VERSION,
  type MailClassifyInput,
  mailClassifyRoute,
  renderEmail,
} from "./mail-classify-route.js";
export { MAIL_KINDS, MailClassification, STAGE_SIGNALS } from "./mail-schema.js";
export {
  authorizeGmail,
  GMAIL_READONLY,
  GmailAccess,
  googleTokenEndpoint,
  type OAuthDeps,
  OAuthError,
} from "./oauth.js";
export {
  ATS_DOMAINS,
  authenticatedDomains,
  backfillQuery,
  isAuthenticatedSender,
  isJobMail,
  JOB_PHRASES,
  underDomain,
} from "./prefilter.js";
export { checkMailProvenance, type ProvenanceFailure } from "./provenance.js";
export {
  type CandidatePick,
  type Catcher,
  createCatcher,
  DEFAULT_WINDOW_MS,
  MAX_WINDOW_MS,
  type OfferResult,
  type Purpose,
  type TimeoutResult,
  type VerificationMessage,
  type VerificationWindow,
  type WindowSpec,
} from "./verify/catcher.js";
export { hasVerificationCode, isVerificationMail, VERIFICATION_PHRASES } from "./verify/detect.js";
export { type Extracted, extractVerification, htmlToText } from "./verify/extract.js";
export {
  checkLink,
  checkRedirectChain,
  type LinkCheck,
  type LinkRefusal,
} from "./verify/link-safety.js";
// The verification-extract fallback (NS-149, VER-003): off by default.
export {
  modelPick,
  VERIFICATION_EXTRACT_VERSION,
  VerificationChoice,
  type VerificationExtractInput,
  verificationExtractRoute,
} from "./verify/model-pick.js";
export { VerificationSecret } from "./verify/secret.js";
