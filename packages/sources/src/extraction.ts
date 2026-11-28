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
    if (lower.startsWith("#")) {
      const code = lower.startsWith("#x")
        ? Number.parseInt(lower.slice(2), 16)
        : Number(lower.slice(1));
      // NUL, surrogates and codes past Unicode stay as written: decoding them would throw or
      // store a byte Postgres refuses, and one odd posting must not sink its board.
      const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return valid ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[lower] ?? m;
  });
}

// HTML as readable text: scripts and styles dropped, block ends as line breaks, list items as
// "- ", other tags as a space, entities decoded. The page is untrusted (a pasted link, a capture,
// a feed item), so it is walked once, forward only (NS-289, #484): the earlier chain of regexes
// rescanned the rest of the page for every unclosed `<script>` and every `<` with no `>` after
// it, so a hostile 2 MB page could stall the run. Output on well-formed pages is unchanged.
export function htmlToText(html: string): string {
  return decodeEntities(stripTags(html))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Elements dropped whole with their content, up to their own closing tag.
const DROPPED = ["script", "style", "noscript"] as const;
// Closing tags that end a line.
const LINE_ENDS = /^<\/(p|div|li|h[1-6]|ul|ol|tr|section)>/i;
const BREAK = /^<br\s*\/?>/i;

// The tags out of the page, in one forward pass. A tag is "<" up to its next ">"; a "<" with no
// ">" after it stays as text. Each search starts at or after the current position, and a search
// that found nothing is remembered, so no part of the page is scanned twice for the same thing.
function stripTags(html: string): string {
  const lower = asciiLower(html);
  const out: string[] = [];
  // The next ">" at or after a position; -1 once none is left.
  let nextGt = -2;
  // Per dropped element, whether a closing tag is still ahead (false once a search found none).
  const closeAhead: Record<(typeof DROPPED)[number], boolean> = {
    script: true,
    style: true,
    noscript: true,
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    // A dropped element: its content up to its closing tag goes, replaced by a space. With no
    // closing tag ahead it is an ordinary tag, as before.
    const dropped = DROPPED.find((name) => lower.startsWith(`<${name}`, lt));
    if (dropped && closeAhead[dropped]) {
      const close = lower.indexOf(`</${dropped}>`, lt);
      if (close >= 0) {
        out.push(" ");
        i = close + dropped.length + 3;
        continue;
      }
      closeAhead[dropped] = false;
    }
    if (nextGt !== -1 && nextGt <= lt) nextGt = html.indexOf(">", lt + 1);
    // No ">" left: this "<" and the rest of the page are text.
    if (nextGt < 0) {
      out.push(html.slice(lt));
      break;
    }
    // "<>" isn't a tag.
    if (nextGt === lt + 1) {
      out.push("<");
      i = lt + 1;
      continue;
    }
    const tag = html.slice(lt, nextGt + 1);
    if (BREAK.test(tag)) out.push("\n");
    else if (LINE_ENDS.test(tag)) out.push("\n");
    else if (lower.startsWith("<li", lt)) out.push("- ");
    else out.push(" ");
    i = nextGt + 1;
  }
  return out.join("");
}

// ASCII letters lower-cased, every other character as it is, so indexes stay the same as the
// page's (toLowerCase can change a string's length for some letters).
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

// "Remote", "Hybrid" or an office location, from the words a posting uses. null if unclear.
export function remoteFrom(...hints: (string | null | undefined)[]): JobFields["remote"] {
  const text = hints.filter(Boolean).join(" ").toLowerCase();
  if (/\bhybrid\b/.test(text)) return "hybrid";
  if (/\bremote\b/.test(text)) return "remote";
  if (/\b(on-?site|in[- ]office)\b/.test(text)) return "onsite";
  return null;
}

// An apply link as it can safely be stored: resolved against the page it came from (pages often
// write "/jobs/123/apply"), http(s) only, any user name or password removed. Anything else
// (javascript:, data:, garbage) is null, so a page can't break or poison the stored job.
// Note for the Apply Gateway: this is still the page's own choice of link; apply only on a host
// that matches the job's source or ATS, never on this value alone.
export function cleanApplyUrl(raw: string | null, pageUrl: string): string | null {
  if (raw === null) return null;
  let u: URL;
  try {
    u = new URL(raw.trim(), pageUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.username = "";
  u.password = "";
  return u.toString();
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
