import type { Ats, JobFields, SourceMethod } from "@northstar/db";

// What any extractor returns for one posting: the fields it could read (null where it couldn't,
// never a guess) and how it read them.
export type Extraction = {
  fields: JobFields;
  method: SourceMethod;
  ats: Ats | null;
  // The ATS's own id for the posting, the best duplicate key (SRC-006).
  atsPostingId: string | null;
};

export const emptyFields = (): JobFields => ({
  title: null,
  company: null,
  location: null,
  remote: null,
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: null,
  salaryPeriod: null,
  seniority: null,
  requirements: [],
  niceToHaves: [],
  applyUrl: null,
  ats: null,
  description: null,
  postedAt: null,
});

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

// Decodes the HTML entities job pages use (named ones above, plus numeric ones).
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number(lower.slice(1)));
    return ENTITIES[lower] ?? m;
  });
}

// HTML as readable text: scripts and styles dropped, block ends as line breaks, entities decoded.
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|ul|ol|tr|section)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// "Remote", "Hybrid" or an office location, from the words a posting uses. null if unclear.
export function remoteFrom(...hints: (string | null | undefined)[]): JobFields["remote"] {
  const text = hints.filter(Boolean).join(" ").toLowerCase();
  if (/\bhybrid\b/.test(text)) return "hybrid";
  if (/\bremote\b/.test(text)) return "remote";
  if (/\b(on-?site|in[- ]office)\b/.test(text)) return "onsite";
  return null;
}

// A date if the value parses to one, else null.
export function dateOrNull(v: unknown): Date | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// A salary bound as a whole number, or null.
export function wholeOrNull(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v.replace(/[,\s]/g, "")) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// Splits a posting's description sections into requirements and nice-to-haves by their headings.
const NICE = /nice|bonus|preferred|plus|extra credit/i;
const REQUIRED =
  /requirement|qualification|what you('ll)? (need|bring)|you have|must have|about you|skills/i;
export function sortSections(
  sections: { heading: string; items: string[] }[],
): Pick<JobFields, "requirements" | "niceToHaves"> {
  const requirements: string[] = [];
  const niceToHaves: string[] = [];
  for (const s of sections) {
    if (NICE.test(s.heading)) niceToHaves.push(...s.items);
    else if (REQUIRED.test(s.heading)) requirements.push(...s.items);
  }
  const clean = (xs: string[]) => xs.map((x) => x.trim()).filter((x) => x.length > 0);
  return { requirements: clean(requirements), niceToHaves: clean(niceToHaves) };
}
