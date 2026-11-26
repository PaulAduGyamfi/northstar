// The job-mail pre-filter (INB-002): plain code decides from headers alone, before any body is
// fetched or anything reaches a model (NFR-SEC-005). It is narrow on purpose: a missed job email
// can be added by hand in `funnel import`, but personal mail sent to a model can't be unsent.

// Sending domains of the common applicant tracking systems (public vendor domains).
export const ATS_DOMAINS = [
  "greenhouse.io",
  "greenhouse-mail.io",
  "lever.co",
  "ashbyhq.com",
  "myworkday.com",
  "myworkdayjobs.com",
  "smartrecruiters.com",
  "icims.com",
  "workablemail.com",
  "workable.com",
  "jobvite.com",
  "bamboohr.com",
  "rippling.com",
  "breezy.hr",
  "recruitee.com",
  "teamtailor.com",
  "applytojob.com",
  "successfactors.com",
  "taleo.net",
] as const;

// Subject phrases specific enough to mean job mail on their own. Generic ones ("your
// application", "next steps", "interview") also appear in mortgage, visa and press mail, so they
// count only inside a thread that's already job mail (the backfill's thread rule), never alone.
export const JOB_PHRASES = [
  "thank you for applying",
  "thanks for applying",
  "your candidacy",
  "phone screen",
  "interview invitation",
  "invitation to interview",
  "coding challenge",
  "technical assessment",
  "offer letter",
  "job offer",
] as const;

const lower = (s: string) => s.toLowerCase();

// True for the domain itself or a subdomain of it: hire.lever.co is lever.co, but
// lever.co.evil.example.com and notlever.co are not.
export function underDomain(domain: string, root: string): boolean {
  return domain === root || domain.endsWith(`.${root}`);
}

// Removes RFC 8601 comments ("(...)", nestable) from an Authentication-Results value. Returns
// null when the value can't be read unambiguously: unbalanced parentheses, or any double quote or
// backslash. Those only appear when a sender chose a quoted envelope address, whose text Gmail
// copies into the header, and a quoted local part may hold ";" and spaces that would read as a
// result of its own. Failing closed costs at most one email treated as unverified.
function withoutComments(value: string): string | null {
  if (/["\\]/.test(value)) return null;
  let depth = 0;
  let out = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) return null;
      depth--;
    } else if (depth === 0) out += ch;
  }
  return depth === 0 ? out : null;
}

const DOMAIN = /^[a-z0-9.-]+$/;

// Gmail's own Authentication-Results header starts with this authserv-id (NS-217). A header any
// other server wrote, or one the sender put in before Gmail, proves nothing, so it is never read.
export const GMAIL_AUTHSERV = /^\s*mx\.google\.com\s*;/i;

// The domains Gmail verified for this message, from its Authentication-Results header: the
// header.from of a DMARC pass, or the signing domain of a DKIM pass. The From header alone can be
// forged by anyone; these can't. The header is read by its structure, not searched as text: the
// envelope sender (`smtp.mailfrom`, and the SPF comment that quotes it) is chosen by whoever sent
// the mail, so "dkim=pass header.d=x" written there must never count. Each ";" part after the
// first (the authserv-id, which must be Gmail's) is one result; it counts only when its method is the first token, and
// its domain is read only from that result's own header.* property tokens.
export function authenticatedDomains(authenticationResults: string | null): string[] {
  if (!authenticationResults || !GMAIL_AUTHSERV.test(authenticationResults)) return [];
  const value = withoutComments(lower(authenticationResults));
  if (value === null) return [];
  const out: string[] = [];
  for (const part of value.split(";").slice(1)) {
    const [method, ...props] = part.trim().split(/\s+/);
    const prop = (name: string) =>
      props.find((t) => t.startsWith(`${name}=`))?.slice(name.length + 1);
    let domain: string | undefined;
    if (method === "dmarc=pass") domain = prop("header.from");
    if (method === "dkim=pass") {
      // header.i is an identity like "@mail.example.com" or "user@example.com".
      const identity = prop("header.i");
      domain = prop("header.d") ?? identity?.slice(identity.lastIndexOf("@") + 1);
    }
    if (domain && DOMAIN.test(domain)) out.push(domain);
  }
  return out;
}

const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const HOST_NAME = new RegExp(`^${LABEL}(\\.${LABEL})+$`);
export const isHostName = (domain: string): boolean =>
  domain.length <= 253 && HOST_NAME.test(domain);

// Whether the sender's domain is one Gmail verified (the verified domain, or one under it).
// A host name: dot-separated labels of letters, digits and hyphens (never at a label's ends), at
// least two labels, at most 253 characters. Anything else (a space, "/", "@", an empty label)
// is never an authenticated sender, whatever the results header says (NS-160).
export function isAuthenticatedSender(headers: {
  senderDomain: string;
  authenticationResults: string | null;
}): boolean {
  const domain = lower(headers.senderDomain);
  return (
    isHostName(domain) &&
    authenticatedDomains(headers.authenticationResults).some((d) => underDomain(domain, d))
  );
}

// Whether a message is job mail, from its headers only (INB-002): an authenticated sender at a
// known ATS, a sender domain already in the funnel, or a job-specific subject phrase. The
// backfill also keeps messages in a job thread.
export function isJobMail(
  headers: { senderDomain: string; subject: string; authenticationResults: string | null },
  knownDomains: ReadonlySet<string>,
): boolean {
  const domain = lower(headers.senderDomain);
  if (domain === "") return false;
  // A forged From: an ATS domain counts only when Gmail verified it.
  if (ATS_DOMAINS.some((root) => underDomain(domain, root)) && isAuthenticatedSender(headers)) {
    return true;
  }
  if (knownDomains.has(domain)) return true;
  const subject = lower(headers.subject);
  return JOB_PHRASES.some((phrase) => subject.includes(phrase));
}

// The Gmail search that lists candidates for the pre-filter: from `since` (YYYY-MM-DD), any ATS
// sender or job phrase. Gmail's {a b} means "a OR b". The pre-filter still checks every result.
export function backfillQuery(since: string): string {
  const terms = [
    ...ATS_DOMAINS.map((d) => `from:${d}`),
    ...JOB_PHRASES.map((p) => `subject:"${p}"`),
  ];
  return `after:${since.replaceAll("-", "/")} {${terms.join(" ")}}`;
}
