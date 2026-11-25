import type { JobFields } from "@northstar/db";
import type { Route } from "@northstar/llm";
import { untrustedBlock } from "@northstar/llm";
import { loadPrompt } from "@northstar/prompts";
import { dateOrNull, emptyFields } from "./extraction.js";
import { JobExtract } from "./job-extract-schema.js";

export const JOB_EXTRACT_VERSION = 1;

// The page text the route sees: enough for one posting; longer pages are cut and marked.
export const PAGE_LIMIT = 12_000;

export type JobExtractInput = { url: string; text: string };

export function renderPage(input: JobExtractInput): string {
  const text =
    input.text.length > PAGE_LIMIT ? `${input.text.slice(0, PAGE_LIMIT)}\n[cut]` : input.text;
  return `address: ${input.url}\n\n${text}`;
}

// The job-extract route (NS-114): one page's text in, the posting's fields out. The page is
// untrusted (NFR-SEC-004) and the route has no tools.
export function jobExtractRoute(): Route<JobExtractInput, JobExtract> {
  const prompt = loadPrompt("job-extract", JOB_EXTRACT_VERSION);
  return {
    name: "job-extract",
    prompt,
    // Copying fields off one page: low effort; the eval set is the check (ADR-0006).
    effort: "low",
    maxTokens: 3_000,
    timeoutMs: 90_000,
    output: JobExtract,
    render: (input) => ({ stable: [], volatile: untrustedBlock("page", renderPage(input)) }),
  };
}

// Lower case with runs of space squashed, so "Senior  Engineer" matches "senior engineer".
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// The page's numbers in every way a salary is written: "$150,000", "150000", "150k".
function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?)\s*([kK])?/g)) {
    const n = Number((m[1] ?? "").replace(/[,.](?=\d{3}\b)/g, ""));
    if (Number.isFinite(n)) out.add(Math.round(m[2] ? n * 1000 : n));
  }
  return out;
}

export type DroppedField = keyof JobExtract;

// Code decides (ADR-0004): every text value must appear in the page, and every salary figure
// must be a number the page states. A value that fails is dropped, never kept as a guess; the
// list of dropped fields goes to the caller (and into nothing else).
export function checkJobProvenance(
  out: JobExtract,
  pageText: string,
): { fields: JobFields; dropped: DroppedField[] } {
  const page = squash(pageText);
  const numbers = numbersIn(pageText);
  const dropped: DroppedField[] = [];
  const text = (
    k: "title" | "company" | "location" | "seniority" | "salaryCurrency",
  ): string | null => {
    const v = out[k];
    if (v === null) return null;
    if (squash(v) !== "" && page.includes(squash(v))) return v.trim();
    dropped.push(k);
    return null;
  };
  const num = (k: "salaryMin" | "salaryMax"): number | null => {
    const v = out[k];
    if (v === null) return null;
    if (numbers.has(Math.round(v))) return Math.round(v);
    dropped.push(k);
    return null;
  };
  const list = (k: "requirements" | "niceToHaves") => {
    const kept = out[k].filter((x) => squash(x) !== "" && page.includes(squash(x)));
    if (kept.length < out[k].length) dropped.push(k);
    return kept.map((x) => x.trim());
  };
  let postedAt: Date | null = null;
  if (out.postedText !== null) {
    if (page.includes(squash(out.postedText))) {
      postedAt = dateOrNull(out.postedText.replace(/^posted( on)?:?\s*/i, ""));
    } else dropped.push("postedText");
  }
  const salaryMin = num("salaryMin");
  const salaryMax = num("salaryMax");
  const hasPay = salaryMin !== null || salaryMax !== null;
  return {
    dropped,
    fields: {
      ...emptyFields(),
      title: text("title"),
      company: text("company"),
      location: text("location"),
      // Remote and the pay period are categories, not quotes: kept as the model read them.
      remote: out.remote,
      salaryMin,
      salaryMax,
      // Currency and period only mean something next to a kept figure.
      salaryCurrency: hasPay ? currency(out.salaryCurrency, pageText, dropped) : null,
      salaryPeriod: hasPay ? out.salaryPeriod : null,
      seniority: text("seniority"),
      requirements: list("requirements"),
      niceToHaves: list("niceToHaves"),
      postedAt,
    },
  };
}

// A currency the page shows as its code or its symbol ("$150,000" is USD). Ambiguous symbols map
// to their most common currency for a job posting; anything else needs the code on the page.
const SYMBOLS: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
};
function currency(code: string | null, pageText: string, dropped: DroppedField[]): string | null {
  if (code === null) return null;
  const c = code.trim().toUpperCase();
  const shown =
    /^[A-Z]{3}$/.test(c) &&
    (pageText.toUpperCase().includes(c) ||
      Object.entries(SYMBOLS).some(([sym, iso]) => iso === c && pageText.includes(sym)));
  if (shown) return c;
  dropped.push("salaryCurrency");
  return null;
}
