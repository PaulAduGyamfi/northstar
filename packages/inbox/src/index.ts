// Public entry of @northstar/inbox (NS-113, ADR-0014): read-only Gmail access, the job-mail
// pre-filter and the mail-classify route. Since NS-123 also the Verification Catcher's core.

// The read-only Calendar client (NS-240, ADR-0026 Proposed): primary calendar events only.
export { CalendarAccess } from "./calendar/access.js";
export {
  CALENDAR_DEPENDENCY,
  type CalendarClient,
  type CalendarDeps,
  CalendarError,
  createCalendarClient,
  EVENT_FIELDS,
  MAX_WINDOW_DAYS,
} from "./calendar/client.js";
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
  type CalendarEvent,
  detectInterview,
  type InterviewCandidate,
  type InterviewDetection,
  type InterviewFormat,
  interviewFormat,
  interviewFromMail,
  type MailInterview,
} from "./interview/detect.js";
// Gmail labels (NS-229, ADR-0027 Proposed): fixed names and the add-only label writer. No caller
// yet, and nothing requests the gmail.modify scope until Paul accepts the ADR.
export { LABEL_NAMES, type LabelOrigin, threadLabels } from "./labels/names.js";
export {
  createLabelWriter,
  LABELS_SUBSYSTEM,
  LabelInputError,
  LabelWriteError,
  type LabelWriter,
} from "./labels/writer.js";
// Linking job mail to applications (NS-158): tags and the deterministic matcher.
export {
  type LinkCandidate,
  type MatchResult,
  type MatchStep,
  matchMail,
  type QueueReason,
  type TagRow,
} from "./link/match.js";
// The mail-link step for one new message (#224).
export {
  ATS_SENDER_DOMAINS,
  type CandidateRow,
  type DotlessDomains,
  GMAIL_DOMAINS,
  isStampedDelivery,
  type LinkDecision,
  type LinkStepDeps,
  linkNewMessage,
  mailboxKey,
  type SkipReason,
  type StepResult,
  toLinkCandidate,
} from "./link/step.js";
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
export { checkRecruiterFacts, MIN_QUOTE_WORDS, type RecruiterCheck } from "./recruiter/check.js";
export { extractRecruiterFacts, type RecruiterExtractResult } from "./recruiter/extract.js";
export {
  RECRUITER_EMAIL_LIMIT,
  RECRUITER_EXTRACT_VERSION,
  type RecruiterExtractInput,
  recruiterExtractRoute,
} from "./recruiter/route.js";
export { RED_FLAGS, RecruiterFacts, type RedFlag } from "./recruiter/schema.js";
export {
  classifyLinkedMail,
  type ReviewReason as TriageReviewReason,
  type TriageDeps,
  type TriageResult,
  type TriageStamp,
} from "./triage.js";
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
export {
  MAX_PER_TICK,
  POLL_INTERVAL_MS,
  type PollDeps,
  type PollGmail,
  type PollResult,
  pollWindow,
  windowQuery,
} from "./verify/poll.js";
export { VerificationSecret } from "./verify/secret.js";
export {
  type CloseReason,
  createStoredCatcher,
  type StoredCatcher,
  type StoredWindow,
  type WindowStore,
} from "./verify/stored-catcher.js";
