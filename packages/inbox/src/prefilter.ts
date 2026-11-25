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

// Subject phrases that mean job mail. No bare "offer", "role" or "opportunity": promotions use them.
export const JOB_PHRASES = [
  "thank you for applying",
  "thanks for applying",
  "your application",
  "application received",
  "application status",
  "application update",
  "your candidacy",
  "interview",
  "phone screen",
  "coding challenge",
  "technical assessment",
  "offer letter",
  "job offer",
  "next steps",
] as const;

const lower = (s: string) => s.toLowerCase();

// True for the domain itself or a subdomain of it: hire.lever.co is lever.co, but
// lever.co.evil.example.com and notlever.co are not.
function underDomain(domain: string, root: string): boolean {
  return domain === root || domain.endsWith(`.${root}`);
}

// Whether a message is job mail, from its sender domain and subject only. `knownDomains` holds the
// sender domains of messages already in the funnel (a company's own recruiter domain).
export function isJobMail(
  headers: { senderDomain: string; subject: string },
  knownDomains: ReadonlySet<string>,
): boolean {
  const domain = lower(headers.senderDomain);
  if (domain === "") return false;
  if (ATS_DOMAINS.some((root) => underDomain(domain, root))) return true;
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
