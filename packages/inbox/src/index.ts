// Public entry of @northstar/inbox (NS-113, ADR-0014): read-only Gmail access, the job-mail
// pre-filter and the mail-classify route.

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
} from "./prefilter.js";
export { checkMailProvenance, type ProvenanceFailure } from "./provenance.js";
