import { normalize } from "../validate.js";
import { headersIn } from "./render.js";
import { mentions } from "./terms.js";
import type { MasterResume, TailorJob } from "./types.js";

// The pre-send score (NS-117, TLR-004): plain code over the rendered resume, shown before
// anything goes out.

// The share of the rendered words a re-parse must recover (TLR-004 acceptance criterion).
export const ATS_MIN_RECOVERED = 0.95;

export type TitleMatch = "exact" | "partial" | "none" | "unknown";
export type KeywordCoverage = { covered: number; total: number; missing: string[] };
export type AtsCheck = { recovered: number; missingHeaders: string[]; pass: boolean };
export type PreSendScore = { title: TitleMatch; keywords: KeywordCoverage; ats: AtsCheck };

// Words too common to count as sharing a title (as in fit scoring).
const STOP = new Set(["and", "the", "for", "with"]);

const significant = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));

// exact: the resume names the job title as a whole phrase; partial: it shares a significant word.
function titleMatch(title: string | null, rendered: string): TitleMatch {
  if (title === null || title.trim() === "") return "unknown";
  if (mentions(rendered, title)) return "exact";
  const words = new Set(significant(rendered));
  return significant(title).some((w) => words.has(w)) ? "partial" : "none";
}

// A requirement is covered when a term the profile knows (a master skill or an atom's `how`)
// appears both in the requirement and in the rendered resume. Requirements, not single words,
// are counted (spec, open questions).
function keywordCoverage(master: MasterResume, job: TailorJob, rendered: string): KeywordCoverage {
  const vocabulary = [...master.skills, ...master.atoms.flatMap((a) => a.how)];
  const all = [...job.requirements, ...job.niceToHaves];
  const missing = all.filter(
    (r) => !vocabulary.some((t) => mentions(r, t) && mentions(rendered, t)),
  );
  return { covered: all.length - missing.length, total: all.length, missing };
}

// Words as a multiset, ignoring case and typography.
function wordCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const w of normalize(text)
    .toLowerCase()
    .match(/[\p{L}\p{N}+#]+/gu) ?? []) {
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return counts;
}

// Compares what a parser read back (`reparsed`) with what was rendered: the share of rendered
// words recovered (rounded to 3 places) and every header the render used, each on a line of its
// own. preSendScoreFromPdf (NS-145) passes the text read back from the rendered PDF.
export function atsParseCheck(rendered: string, reparsed: string): AtsCheck {
  const want = wordCounts(rendered);
  const got = wordCounts(reparsed);
  let total = 0;
  let found = 0;
  for (const [w, n] of want) {
    total += n;
    found += Math.min(n, got.get(w) ?? 0);
  }
  const recovered = total === 0 ? 1 : Math.round((1000 * found) / total) / 1000;
  const lines = new Set(reparsed.split("\n").map((l) => l.trim()));
  const missingHeaders = headersIn(rendered).filter((h) => !lines.has(h));
  return {
    recovered,
    missingHeaders,
    pass: recovered >= ATS_MIN_RECOVERED && missingHeaders.length === 0,
  };
}

export function preSendScore(input: {
  master: MasterResume;
  job: TailorJob;
  rendered: string;
  reparsed: string;
}): PreSendScore {
  return {
    title: titleMatch(input.job.title, input.rendered),
    keywords: keywordCoverage(input.master, input.job, input.rendered),
    ats: atsParseCheck(input.rendered, input.reparsed),
  };
}
