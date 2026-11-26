import { ATS_DOMAINS, underDomain } from "../prefilter.js";
import { extractVerification } from "./extract.js";

// Spotting verification mail from headers alone (VER-005, NS-150), so callers that read job mail
// (the funnel backfill today) can drop it before any body is fetched, classified or stored. A
// code or link must never reach a model, a call record or a table.

// Subject phrases ATS vendors use for sign-up, sign-in and reset mail. Lower case, single spaces;
// matched as substrings of the subject once it is lower-cased and its whitespace collapsed.
// "passcode" also covers "one-time passcode".
export const VERIFICATION_PHRASES = [
  "verify your email",
  "verify your e-mail",
  "verify your account",
  "verification code",
  "security code",
  "one-time code",
  "one time code",
  "one-time password",
  "passcode",
  "login code",
  "sign-in link",
  "sign in link",
  "confirm your account",
  "confirm your email",
  "reset your password",
  "password reset",
] as const;

// True when an ATS-domain sender sends a verification subject. Gmail's verification of the sender
// is not required: skipping a forged message only keeps it out of the funnel, while letting it
// through could send a real code to the model.
// A verification subject from any sender, not only an ATS: an employer's own portal or an
// assessment vendor sends these too (the mail-link step, #224; triage has the same subject rule).
export function hasVerificationSubject(subject: string): boolean {
  const normal = subject.toLowerCase().replace(/\s+/g, " ");
  return VERIFICATION_PHRASES.some((phrase) => normal.includes(phrase));
}

export function isVerificationMail(headers: { senderDomain: string; subject: string }): boolean {
  if (!fromAts(headers.senderDomain)) return false;
  // Any run of whitespace (a double or non-breaking space too) reads as one space.
  const subject = headers.subject.toLowerCase().replace(/\s+/g, " ");
  return VERIFICATION_PHRASES.some((phrase) => subject.includes(phrase));
}

// The second check, for a caller that already holds the body for another reason (the backfill,
// just before the model): an ATS sender's body with a verification code in it (INB-012: mail
// matching the VER-003 code patterns never reaches a model). Codes only: ATS job mail often
// carries portal links, so a link alone would drop real job mail.
export function hasVerificationCode(senderDomain: string, body: string): boolean {
  return fromAts(senderDomain) && extractVerification(body, null).codes.length > 0;
}

function fromAts(senderDomain: string): boolean {
  const domain = senderDomain.toLowerCase();
  return domain !== "" && ATS_DOMAINS.some((root) => underDomain(domain, root));
}
