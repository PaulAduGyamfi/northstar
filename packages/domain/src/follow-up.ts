import { z } from "zod";
import type { ApplicationStatus } from "./application-status.js";
import type { MailKind } from "./mail-status.js";
import type { Result } from "./result.js";

// Follow-up nudges (RPL-004, NS-237 slice 3): which applications have gone quiet long enough to
// draft a polite follow-up for Paul's approval. Plain code: the clock, the stage and what is
// already filed decide, never a model.

// The stages a nudge is drafted for, and the statuses in each. Every other status gets none: an
// application not yet sent has nobody to follow up with, and an ending needs no nudge.
export const NUDGE_STAGES = {
  applied: ["submitted", "confirmed"],
  interview: ["in_process"],
} as const satisfies Record<string, readonly ApplicationStatus[]>;
export type NudgeStage = keyof typeof NUDGE_STAGES;

// Days of silence before a nudge, per stage. An interview loop moves faster than a fresh
// application, so it is nudged sooner.
export type NudgeDays = Record<NudgeStage, number>;
export const DEFAULT_NUDGE_DAYS: NudgeDays = { applied: 7, interview: 5 };

// Whole days from 1 to 60: a nudge the same day is pushy, and two months of silence is an answer.
const Days = z.number().int().min(1).max(60);
const NudgeDaysInput = z.object({ applied: Days, interview: Days }).strict();

export type InvalidNudgeDays = { kind: "InvalidNudgeDays"; fields: string[] };

export function parseNudgeDays(input: unknown): Result<NudgeDays, InvalidNudgeDays> {
  const parsed = NudgeDaysInput.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "days"))];
  return { ok: false, error: { kind: "InvalidNudgeDays", fields } };
}

// The kinds of newest message after which it is the company's turn: a confirmation or a plain
// note. Mail that waits on Paul (a question, an assessment, scheduling) gets a reply from him, not a
// nudge; a rejection or an offer ends the wait; an unclassified message is never guessed at.
export const NUDGE_AFTER_KINDS: readonly MailKind[] = ["confirmation", "info_other"];

// One application as the nudge check sees it: its status, when it last moved, and its newest
// linked message (the one a nudge replies on), if any.
export type NudgeCandidate = {
  applicationId: string;
  status: ApplicationStatus;
  lastMoveAt: Date;
  // kind: the message's stored classification (INB-003), or null until it is classified (#224).
  lastMail: {
    gmailMessageId: string;
    threadId: string;
    receivedAt: Date;
    kind: MailKind | null;
  } | null;
  // A reply draft is already filed for lastMail (one live reply per message, the Gate's subject).
  replyFiled: boolean;
};

export type NudgeDue = {
  applicationId: string;
  stage: NudgeStage;
  gmailMessageId: string;
  threadId: string;
  silentDays: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function stageOf(status: ApplicationStatus): NudgeStage | null {
  for (const [stage, statuses] of Object.entries(NUDGE_STAGES) as [
    NudgeStage,
    readonly ApplicationStatus[],
  ][]) {
    if (statuses.includes(status)) return stage;
  }
  return null;
}

// The applications due a nudge now, the longest silent first (then by id, so the order is fixed).
export function nudgesDue(
  candidates: readonly NudgeCandidate[],
  days: NudgeDays,
  now: Date,
): NudgeDue[] {
  const due: NudgeDue[] = [];
  for (const c of candidates) {
    const stage = stageOf(c.status);
    // No thread means nothing to reply on; a filed draft means one already waits or was decided.
    if (stage === null || c.lastMail === null || c.replyFiled) continue;
    // Only when the newest message leaves the next move to the company.
    if (c.lastMail.kind === null || !NUDGE_AFTER_KINDS.includes(c.lastMail.kind)) continue;
    // Silence is counted from the newest sign of life: a status move or a linked message.
    const lastActivity = Math.max(c.lastMoveAt.getTime(), c.lastMail.receivedAt.getTime());
    const silentDays = Math.floor((now.getTime() - lastActivity) / DAY_MS);
    if (silentDays < days[stage]) continue;
    due.push({
      applicationId: c.applicationId,
      stage,
      gmailMessageId: c.lastMail.gmailMessageId,
      threadId: c.lastMail.threadId,
      silentDays,
    });
  }
  return due.sort(
    (a, b) => b.silentDays - a.silentDays || a.applicationId.localeCompare(b.applicationId),
  );
}
