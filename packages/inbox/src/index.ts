// Public entry of @northstar/inbox (NS-113, ADR-0014): read-only Gmail access, the job-mail
// pre-filter and the mail-classify route.
export { type GoogleConfig, loadGoogleConfig } from "./config.js";
export {
  authorizeGmail,
  GMAIL_READONLY,
  GmailAccess,
  googleTokenEndpoint,
  type OAuthDeps,
  OAuthError,
} from "./oauth.js";
