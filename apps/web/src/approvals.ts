import { z } from "zod";

// The approval queue page (NS-139, APR-001…003): the API's answers and the plain decisions made
// from them. The browser talks only to the API; every decision goes through Paul's session.

// The Gate's kinds: a copy of APPROVAL_KINDS in packages/domain/src/approval.ts. The web app
// doesn't depend on the domain package, so the list is repeated here. Add a new Gate kind here in
// the same PR, or the queue refuses to parse (QueueBody) and the page says it can't be read.
const KINDS = [
  "application_package",
  "answer",
  "email_reply",
  "outreach",
  "profile_fix",
  "growth_plan",
  "prep_plan",
] as const;
export type ApprovalKind = (typeof KINDS)[number];

export const KIND_WORDS: Record<ApprovalKind, string> = {
  application_package: "Application",
  answer: "New answer",
  email_reply: "Email reply",
  outreach: "Outreach",
  profile_fix: "Profile fix",
  growth_plan: "Growth plan",
  prep_plan: "Prep plan",
};

const Item = z.object({
  requestId: z.string(),
  kind: z.enum(KINDS),
  subject: z.string(),
  requestedAt: z.string(),
});
export type QueueItem = z.infer<typeof Item>;
export const QueueBody = z.object({ items: z.array(Item) });

export const Outcome = z.union([
  z.object({
    requestId: z.string(),
    outcome: z.enum(["approved", "rejected"]),
    decisionId: z.string(),
    effectiveAt: z.string(),
  }),
  z.object({ requestId: z.string(), outcome: z.enum(["not_found", "already_decided"]) }),
]);
export type Outcome = z.infer<typeof Outcome>;
export const DecideBody = z.object({ outcomes: z.array(Outcome) });

// One call decides at most this many (the API's MAX_BATCH): "Approve all" sends several.
export const MAX_BATCH = 100;

// Whole seconds until a decision takes effect: the undo window, read from the API's
// `effectiveAt` (the database clock), so the browser's clock only counts it down.
export function secondsLeft(effectiveAt: string, nowMs: number): number {
  const at = Date.parse(effectiveAt);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

export function undoLabel(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `Undo (${m}:${String(s).padStart(2, "0")})`;
}

// The undo button for one batch of decisions: what it undoes, and the time left.
export function batchUndoLabel(
  decision: "approved" | "rejected",
  count: number,
  seconds: number,
): string {
  const verb = decision === "approved" ? "approving" : "rejecting";
  return undoLabel(seconds).replace("Undo", `Undo ${verb} ${count}`);
}

// What an undo's refusal means, in words (the API's codes for POST /approvals/undo).
export function undoErrorWords(status: number, code: unknown): string {
  if (status === 401) return "You've been signed out. Sign in again to undo.";
  if (code === "undo_window_closed") return "Too late to undo: the window has closed.";
  if (code === "already_undone") return "That was already undone.";
  if (code === "subject_reopened") return "It can't be undone: it's been asked for again.";
  if (status >= 500) return "That didn't go through. Try undo again.";
  return "That decision can't be undone any more.";
}

// How long an item has waited, in the largest whole unit.
export function waitedFor(requestedAt: string, nowMs: number): string {
  const minutes = Math.floor((nowMs - Date.parse(requestedAt)) / 60_000);
  if (Number.isNaN(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

// One plain sentence for a batch's outcomes.
export function summarizeOutcomes(outcomes: Outcome[]): string {
  const approved = outcomes.filter((o) => o.outcome === "approved").length;
  const rejected = outcomes.filter((o) => o.outcome === "rejected").length;
  const already = outcomes.filter((o) => o.outcome === "already_decided").length;
  const gone = outcomes.filter((o) => o.outcome === "not_found").length;
  const parts: string[] = [];
  if (approved > 0) parts.push(`Approved ${approved}.`);
  if (rejected > 0) parts.push(`Rejected ${rejected}.`);
  if (already > 0) parts.push(`${already} ${already === 1 ? "was" : "were"} already decided.`);
  if (gone > 0) parts.push(`${gone} ${gone === 1 ? "is" : "are"} no longer in the queue.`);
  return parts.length > 0 ? parts.join(" ") : "Nothing was decided.";
}
