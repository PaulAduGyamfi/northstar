import { z } from "zod";
import { waitedFor } from "./approvals";

// The pipeline page (NS-168, DSH-001, DSH-006): the API's answers and the plain decisions made
// from them.

// The application state machine's statuses, in pipeline order: a copy of APPLICATION_STATUSES in
// packages/domain/src/application-status.ts (the web app doesn't depend on the domain package).
// A new status needs a word below in the same PR, or the board refuses to parse.
export const APPLICATION_STATUSES = [
  "discovered",
  "scored",
  "queued",
  "package_ready",
  "awaiting_approval",
  "submitting",
  "needs_human",
  "submitted",
  "confirmed",
  "in_process",
  "offer",
  "rejected",
  "withdrawn",
  "ghosted",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

// One status vocabulary everywhere (UX-020, tokens.md): found, queued, awaiting you, submitting,
// submitted, needs your hands, interviewing, offer, closed. Every ending but an offer is a
// neutral "closed", never "rejected" (tokens.md; no loss copy, UX-045).
export const STATUS_WORDS: Record<ApplicationStatus, string> = {
  discovered: "found",
  scored: "found",
  queued: "queued",
  package_ready: "queued",
  awaiting_approval: "awaiting you",
  submitting: "submitting",
  needs_human: "needs your hands",
  submitted: "submitted",
  confirmed: "submitted",
  in_process: "interviewing",
  offer: "offer",
  rejected: "closed",
  withdrawn: "closed",
  ghosted: "closed",
};

const Application = z.object({
  applicationId: z.string(),
  status: z.enum(APPLICATION_STATUSES),
  jobTitle: z.string().nullable(),
  company: z.string().nullable(),
  ats: z.string().nullable(),
  // The job's latest fit (NS-207); null while it is unscored.
  fitScore: z.number().nullable(),
  fitBand: z.enum(["queue", "suggest", "skip"]).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ApplicationView = z.infer<typeof Application>;
export const ApplicationsBody = z.object({ items: z.array(Application) });

const Item = z.object({
  occurredAt: z.string(),
  type: z.string(),
  actor: z.string(),
  line: z.string(),
});
export type TimelineView = z.infer<typeof Item>;
export const TimelineBody = z.object({ application: Application, items: z.array(Item) });

export type Column = { word: string; items: ApplicationView[] };

// The board: one column per status word that has applications, in the state machine's order.
// Within a column, the API's order (newest change first) is kept.
export function boardColumns(apps: ApplicationView[]): Column[] {
  const words = [...new Set(APPLICATION_STATUSES.map((s) => STATUS_WORDS[s]))];
  return words
    .map((word) => ({ word, items: apps.filter((a) => STATUS_WORDS[a.status] === word) }))
    .filter((c) => c.items.length > 0);
}

// A card's title. A draft job may have no title or company yet (NS-114).
export function cardTitle(a: ApplicationView): string {
  return `${a.jobTitle ?? "Untitled job"} at ${a.company ?? "Unknown company"}`;
}

// "changed 3 h ago", or "changed just now".
export function changedAgo(updatedAt: string, nowMs: number): string {
  const waited = waitedFor(updatedAt, nowMs);
  return waited === "just now" ? "changed just now" : `changed ${waited} ago`;
}

// The pipeline's filters and view (NS-207, DSH-001), kept in the URL so a view can be bookmarked.
// The API applies them; the page only reads and writes the query string.
export const FIT_BANDS = ["queue", "suggest", "skip"] as const;
export type FitBand = (typeof FIT_BANDS)[number];
export const BAND_WORDS: Record<FitBand, string> = {
  queue: "Queue",
  suggest: "Suggest",
  skip: "Skip",
};
// The ATS names the sources know (a copy of ATS_KINDS in packages/db/src/schema.ts: add a new
// ATS here in the same PR), plus "other" for a job with none.
export const SOURCES = [
  "greenhouse",
  "lever",
  "ashby",
  "workday",
  "smartrecruiters",
  "workable",
  "other",
] as const;

export type Filters = {
  company?: string;
  band?: FitBand;
  source?: string;
  from?: string;
  to?: string;
};
export type PipelineQuery = { filters: Filters; view: "board" | "table" };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
// A real calendar day: 2026-13-01 and 2026-02-30 aren't (the API refuses them too).
function realDay(d: string): boolean {
  if (!DAY.test(d)) return false;
  const ms = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(d);
}
const one = (v: string | string[] | undefined): string | undefined =>
  typeof v === "string" ? v.trim() : undefined;

// Reads the page's search params, keeping only well-formed fields (the API checks them again).
// An empty field means no filter.
export function parseFilters(params: Record<string, string | string[] | undefined>): PipelineQuery {
  const filters: Filters = {};
  const company = one(params.company);
  if (company && company.length <= 100 && !/\p{Cc}/u.test(company)) filters.company = company;
  const band = one(params.band);
  if (band && (FIT_BANDS as readonly string[]).includes(band)) filters.band = band as FitBand;
  const source = one(params.source);
  if (source && (SOURCES as readonly string[]).includes(source)) filters.source = source;
  const from = one(params.from);
  if (from && realDay(from)) filters.from = from;
  const to = one(params.to);
  if (to && realDay(to)) filters.to = to;
  // A reversed range would be refused by the API: drop both ends rather than show an error.
  if (filters.from && filters.to && filters.from > filters.to) {
    delete filters.from;
    delete filters.to;
  }
  return { filters, view: one(params.view) === "table" ? "table" : "board" };
}

// The query string for these filters (and a view), "" when there are none. Fields in a fixed
// order, so the same view always has the same URL.
export function filterQuery(filters: Filters, view?: "board" | "table"): string {
  const params = new URLSearchParams();
  for (const key of ["company", "band", "source", "from", "to"] as const) {
    const value = filters[key];
    if (value !== undefined) params.set(key, value);
  }
  if (view === "table") params.set("view", "table");
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

export type TableRow = {
  applicationId: string;
  title: string;
  company: string;
  status: string;
  fit: string;
  changed: string;
};

// The table view's rows, in the API's order (newest change first). Status in words (UX-020).
export function tableRows(apps: ApplicationView[], nowMs: number): TableRow[] {
  return apps.map((a) => ({
    applicationId: a.applicationId,
    title: a.jobTitle ?? "Untitled job",
    company: a.company ?? "Unknown company",
    status: STATUS_WORDS[a.status],
    fit:
      a.fitScore === null || a.fitBand === null
        ? "not scored"
        : `${a.fitScore} · ${BAND_WORDS[a.fitBand]}`,
    changed: changedAgo(a.updatedAt, nowMs),
  }));
}
