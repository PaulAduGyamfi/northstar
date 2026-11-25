// Every job source declares its terms status (.claude/rules/gateways.md, ADR-0003). `prohibited`
// sites are never fetched: Paul captures them himself (`jobs add --text`, later the extension).

export type Terms = "official-api" | "public-feed" | "user-session-capture" | "prohibited";

export type SourceTerms = { source: string; terms: Terms };

// Sites whose terms forbid automated access, matched on the registrable domain so a subdomain or
// a country site counts too (uk.indeed.com, indeed.co.uk, www.glassdoor.ca).
const PROHIBITED = [
  /(^|\.)linkedin\.com$/,
  /(^|\.)lnkd\.in$/,
  /(^|\.)indeed\.[a-z.]+$/,
  /(^|\.)glassdoor\.[a-z.]+$/,
];

const ATS_HOSTS: [RegExp, string][] = [
  [/^(boards|job-boards)\.greenhouse\.io$/, "greenhouse"],
  [/^jobs\.(eu\.)?lever\.co$/, "lever"],
  [/^jobs\.ashbyhq\.com$/, "ashby"],
  [/\.myworkdayjobs\.com$/, "workday"],
  [/^(api|jobs|careers)\.smartrecruiters\.com$/, "smartrecruiters"],
  [/^(apply|www)\.workable\.com$/, "workable"],
  // The board APIs NS-115 polls, on their own hosts.
  [/^(boards-api\.greenhouse\.io|api\.lever\.co|api\.ashbyhq\.com)$/, "ats-api"],
];

export function termsFor(url: string): SourceTerms {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { source: "invalid", terms: "prohibited" };
  }
  if (PROHIBITED.some((re) => re.test(host))) return { source: host, terms: "prohibited" };
  for (const [re, source] of ATS_HOSTS) {
    // The ATSs publish these job-board endpoints for anyone to read.
    if (re.test(host)) return { source, terms: "official-api" };
  }
  // A company's own careers page: public, read once at Paul's request.
  return { source: "careers-page", terms: "public-feed" };
}
