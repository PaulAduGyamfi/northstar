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
  "vault_reveal",
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
  vault_reveal: "Password reveal",
};

const Item = z.object({
  requestId: z.string(),
  kind: z.enum(KINDS),
  subject: z.string(),
  requestedAt: z.string(),
  // The request replaced one Paul edited (NS-203 slice 3).
  edited: z.boolean(),
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
  z.object({
    requestId: z.string(),
    // missing_draft: an email reply with nothing stored behind it is never approved (NS-237).
    // approve_alone: a reply to another domain than the sender's is approved only on its own.
    outcome: z.enum(["not_found", "already_decided", "missing_draft", "approve_alone"]),
  }),
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
  const empty = outcomes.filter((o) => o.outcome === "missing_draft").length;
  const alone = outcomes.filter((o) => o.outcome === "approve_alone").length;
  const parts: string[] = [];
  if (approved > 0) parts.push(`Approved ${approved}.`);
  if (rejected > 0) parts.push(`Rejected ${rejected}.`);
  if (already > 0) parts.push(`${already} ${already === 1 ? "was" : "were"} already decided.`);
  if (gone > 0) parts.push(`${gone} ${gone === 1 ? "is" : "are"} no longer in the queue.`);
  if (empty > 0) {
    parts.push(
      `${empty} ${empty === 1 ? "reply has" : "replies have"} no draft to show, so ${empty === 1 ? "it wasn't" : "they weren't"} approved.`,
    );
  }
  if (alone > 0) {
    parts.push(
      `${alone} ${alone === 1 ? "reply goes" : "replies go"} to another domain than the sender's: show ${alone === 1 ? "it" : "each"} and approve ${alone === 1 ? "it" : "each"} on its own.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : "Nothing was decided.";
}

// The reply draft behind an "Email reply" item (NS-237, the API's GET /approvals/reply).
export const ReplyBody = z.object({
  to: z.string(),
  replyToOtherDomain: z.boolean(),
  subject: z.string(),
  body: z.string(),
  cites: z.array(z.string()),
  followUps: z.array(z.string()),
});
export type ReplyBody = z.infer<typeof ReplyBody>;

// The mark next to a request Paul edited (NS-203 slice 3), and what its reply view says in place
// of the cites line: the text is his now, so the first draft's cites may no longer back it.
export const EDITED_MARK = "Edited by you";
export const EDITED_LINE = "Edited by you: you changed this reply's text after it was drafted.";

// What Paul reads before he approves a reply, line by line, shown as plain text: who it goes to
// first, with a warning when that is another domain than the sender's own (RPL-002).
export function replyLines(reply: ReplyBody, edited = false): string[] {
  const lines = [`To: ${reply.to}`];
  if (reply.replyToOtherDomain) {
    lines.push("Check the address: the sender asked for replies on another domain than theirs.");
  }
  lines.push(`Subject: ${reply.subject}`, reply.body);
  for (const q of reply.followUps) lines.push(`Question for you: ${q}`);
  if (edited) {
    lines.push(EDITED_LINE);
    return lines;
  }
  const n = reply.cites.length;
  lines.push(
    n === 0 ? "It cites none of your stories or atoms." : `It cites ${n} of your stories or atoms.`,
  );
  return lines;
}

// Editing a waiting reply's body before approving it (NS-203 slice 2, APR-002). The API's
// POST /approvals/edit-reply files the edit with the Gate; these decide what the page sends and
// says. The body limit mirrors the reply package schema's (packages/domain, reply-draft.ts), which
// editReplyDraft checks; the endpoint's own 10,000 only bounds the request's size.
export const MAX_REPLY_BODY = 5_000;

// Why an edit can't be sent, or null when it can. Nothing goes out for these: the API would
// refuse them anyway, and an unchanged body would only withdraw and re-file the same content.
export function editProblem(original: string, edited: string): string | null {
  if (edited.trim().length === 0) return "The reply can't be empty.";
  if (edited.length > MAX_REPLY_BODY) {
    return `The reply is too long: at most ${MAX_REPLY_BODY.toLocaleString("en-US")} characters.`;
  }
  if (edited === original) return "Nothing changed, so there's nothing to save.";
  return null;
}

// The edit's answer in plain words. A 409 `not_pending` is usually a second click landing after
// the first one's edit (or a decision) already went through, so it reads as done, not failed.
export function editResultWords(status: number, code: unknown): string {
  if (status === 200) return "Saved. Your edited version is waiting for your approval.";
  if (status === 401) return "You've been signed out. Sign in again to edit.";
  if (code === "not_pending") return "That reply isn't waiting any more, so nothing changed.";
  if (code === "unchanged") return "Nothing changed, so there's nothing to save.";
  if (code === "not_editable") return "Only email replies can be edited.";
  if (code === "not_found") return "That reply is gone. Reload the page.";
  if (code === "invalid_body")
    return "Northstar couldn't accept that text. Check it and try again.";
  if (status >= 500) return "That didn't save. Try again.";
  return "That edit couldn't be saved.";
}

// A waiting application package's answers (NS-203 slice 5, the API's GET /approvals/package):
// each filled field's form label, its value and whether Paul may edit it here.
export const PackageBody = z.object({
  answers: z.array(
    z.object({
      fieldName: z.string(),
      label: z.string(),
      value: z.string(),
      editable: z.boolean(),
    }),
  ),
});
export type PackageAnswer = z.infer<typeof PackageBody>["answers"][number];

// The package schema's own limit on one text answer (packages/domain, apply-package.ts).
export const MAX_ANSWER = 10_000;

// What Paul reads before he approves a package, one line per answer, as plain text. A choice
// field says it can't be edited here (its value must be one of the form's own options).
export function packageLines(answers: PackageAnswer[], edited = false): string[] {
  if (answers.length === 0) return ["This application fills no questions."];
  const lines = answers.map(
    (a) => `${a.label}: ${a.value}${a.editable ? "" : " (a choice: not editable here)"}`,
  );
  if (edited) lines.push("Edited by you: you changed these answers after they were filled.");
  return lines;
}

// The answers Paul changed, by field name: only editable ones whose text differs.
export function changedAnswers(
  answers: PackageAnswer[],
  drafts: Readonly<Record<string, string>>,
): Record<string, string> {
  const changed: Record<string, string> = {};
  for (const a of answers) {
    const draft = drafts[a.fieldName];
    if (a.editable && draft !== undefined && draft !== a.value) changed[a.fieldName] = draft;
  }
  return changed;
}

// Why a package edit can't be sent, or null when it can. Nothing goes out for these.
export function packageEditProblem(changed: Readonly<Record<string, string>>): string | null {
  const values = Object.values(changed);
  if (values.length === 0) return "Nothing changed, so there's nothing to save.";
  if (values.some((v) => v.trim().length === 0)) return "An answer can't be empty.";
  if (values.some((v) => v.length > MAX_ANSWER)) {
    return `An answer is too long: at most ${MAX_ANSWER.toLocaleString("en-US")} characters.`;
  }
  return null;
}

// A package edit's answer in plain words, like editResultWords for a reply.
export function packageEditResultWords(status: number, code: unknown): string {
  if (status === 200) {
    return "Saved. Your edited application is waiting for your approval, every answer marked new.";
  }
  if (status === 401) return "You've been signed out. Sign in again to edit.";
  if (code === "not_pending") return "That application isn't waiting any more, so nothing changed.";
  if (code === "unchanged") return "Nothing changed, so there's nothing to save.";
  if (code === "not_editable") return "That application can't be edited.";
  if (code === "not_found") return "That application is gone. Reload the page.";
  if (code === "invalid_body" || code === "invalid_input") {
    return "Northstar couldn't accept those answers. Check them and try again.";
  }
  if (status >= 500) return "That didn't save. Try again.";
  return "That edit couldn't be saved.";
}
