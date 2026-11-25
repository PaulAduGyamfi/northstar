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
// neutral "closed", never "rejected" (UX-045).
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
