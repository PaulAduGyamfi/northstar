import {
  dateOrNull,
  type Extraction,
  emptyFields,
  htmlToText,
  remoteFrom,
  wholeOrNull,
} from "./extraction.js";

// schema.org JobPosting JSON-LD (NS-114): most careers pages publish it for search engines, so a
// page with it needs no model at all. Values are read as written; nothing is inferred.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

// Every JSON value in the page's ld+json script tags, unparseable blocks skipped.
function ldBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      out.push(JSON.parse(m[1] ?? ""));
    } catch {
      // A broken block on the page isn't a reason to fail the posting.
    }
  }
  return out;
}

// The first JobPosting anywhere in those blocks (top level, in an array, or in an @graph).
export function findJobPosting(html: string): Obj | null {
  const queue = ldBlocks(html);
  while (queue.length > 0) {
    const v = queue.shift();
    if (Array.isArray(v)) queue.push(...v);
    else if (isObj(v)) {
      const type = v["@type"];
      if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) return v;
      if (Array.isArray(v["@graph"])) queue.push(...v["@graph"]);
    }
  }
  return null;
}

function locationOf(p: Obj): string | null {
  const places = Array.isArray(p.jobLocation) ? p.jobLocation : [p.jobLocation];
  const names = places.flatMap((place) => {
    if (!isObj(place)) return [];
    const a = isObj(place.address) ? place.address : null;
    const parts = a
      ? [
          str(a.addressLocality),
          str(a.addressRegion),
          str(a.addressCountry) ?? (isObj(a.addressCountry) ? str(a.addressCountry.name) : null),
        ]
      : [str(place.name)];
    const name = parts.filter(Boolean).join(", ");
    return name ? [name] : [];
  });
  return names.length > 0 ? [...new Set(names)].join("; ") : null;
}

const PERIODS: Record<string, "year" | "month" | "hour"> = {
  YEAR: "year",
  MONTH: "month",
  HOUR: "hour",
};

// A string, or a list of strings, as list items (qualifications and skills come either way).
const items = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v])
    .map((x) => (typeof x === "string" ? htmlToText(x) : null))
    .filter((x): x is string => x !== null && x !== "")
    .flatMap((x) => x.split("\n").map((l) => l.replace(/^- /, "").trim()))
    .filter((x) => x !== "");

export function fromJsonLd(html: string): Extraction | null {
  const p = findJobPosting(html);
  if (!p) return null;
  const org = isObj(p.hiringOrganization)
    ? str(p.hiringOrganization.name)
    : str(p.hiringOrganization);
  const salary = isObj(p.baseSalary) ? p.baseSalary : null;
  const value = salary && isObj(salary.value) ? salary.value : null;
  const single = wholeOrNull(value?.value);
  const unit = str(value?.unitText)?.toUpperCase();
  const location = locationOf(p);
  const remoteHint = p.jobLocationType === "TELECOMMUTE" ? "remote" : null;
  return {
    method: "jsonld",
    ats: null,
    atsPostingId: null,
    fields: {
      ...emptyFields(),
      title: str(p.title),
      company: org,
      location,
      remote: remoteFrom(remoteHint, location),
      salaryMin: wholeOrNull(value?.minValue) ?? single,
      salaryMax: wholeOrNull(value?.maxValue) ?? single,
      salaryCurrency: str(salary?.currency),
      salaryPeriod: unit ? (PERIODS[unit] ?? null) : null,
      seniority: str(p.experienceLevel),
      requirements: [...items(p.qualifications), ...items(p.skills)],
      applyUrl: str(p.url),
      description: typeof p.description === "string" ? htmlToText(p.description) : null,
      postedAt: dateOrNull(p.datePosted),
    },
  };
}
