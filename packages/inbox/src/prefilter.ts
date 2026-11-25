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

// The domains Gmail verified for this message, from its Authentication-Results header: the
// header.from of a DMARC pass, or the signing domain of a DKIM pass. The From header alone can be
// forged by anyone; these can't.
export function authenticatedDomains(authenticationResults: string | null): string[] {
  if (!authenticationResults) return [];
  const out: string[] = [];
  for (const part of authenticationResults.split(";")) {
    const p = lower(part);
    if (/\bdmarc=pass\b/.test(p)) {
      const d = /header\.from=([a-z0-9.-]+)/.exec(p)?.[1];
      if (d) out.push(d);
    }
    if (/\bdkim=pass\b/.test(p)) {
      const d =
        /header\.d=([a-z0-9.-]+)/.exec(p)?.[1] ?? /header\.i=[^@\s]*@([a-z0-9.-]+)/.exec(p)?.[1];
      if (d) out.push(d);
    }
  }
  return out;
}

// Whether the sender's domain is one Gmail verified (the verified domain, or one under it).
export function isAuthenticatedSender(headers: {
  senderDomain: string;
  authenticationResults: string | null;
}): boolean {
  const domain = lower(headers.senderDomain);
  return (
    domain !== "" &&
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
