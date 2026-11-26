import { z } from "zod";

// Stuck work (NS-215, RES-007): the API's open dead letters and the plain words they are shown in,
// including what happens after Paul's retry, skip or hand-off.

export const DeadLettersBody = z.object({
  items: z.array(
    z.object({
      deadLetterId: z.string(),
      kind: z.string(),
      reasonCode: z.string(),
      attempts: z.number(),
      deadAt: z.string(),
    }),
  ),
});
export type DeadLetterItem = z.infer<typeof DeadLettersBody>["items"][number];

export const DEAD_LETTER_ACTIONS = ["retry", "skip", "hand_off"] as const;
export type DeadLetterAction = (typeof DEAD_LETTER_ACTIONS)[number];

export const ACTION_LABELS: Record<DeadLetterAction, string> = {
  retry: "Retry",
  skip: "Skip",
  hand_off: "Hand off",
};

type KindWords = { what: string; next: Record<DeadLetterAction, string> };

// Each producer's kind, in words. A kind not listed still shows, as itself.
const KINDS: Record<string, KindWords> = {
  "apply.stale_sweep": {
    what: "Closing stale application claims",
    next: {
      // The sweep retries on its own every pass (apps/worker sweep.ts): no action starts work.
      retry:
        "Nothing runs now: the sweep already tries again on every pass, every few minutes. If it keeps failing, a new item shows here.",
      skip: "Nothing more is done about this pass. Later passes still run.",
      hand_off:
        "Nothing runs now: the sweep keeps trying on its own passes. There's no page for open claims yet, so check the Apply ledger in the database if this keeps happening.",
    },
  },
};

const REASONS: Record<string, string> = {
  sweep_failed: "every attempt failed",
};

// Own keys only: a code such as "constructor" must not find Object's built-ins.
const own = <T>(map: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;

// One letter as shown: what stopped, why, after how many attempts and when.
export function letterLine(item: DeadLetterItem): { what: string; why: string } {
  const what = own(KINDS, item.kind)?.what ?? item.kind;
  const reason = own(REASONS, item.reasonCode) ?? item.reasonCode.replaceAll("_", " ");
  const attempts = item.attempts === 1 ? "1 attempt" : `${item.attempts} attempts`;
  return { what, why: `Stopped after ${attempts}: ${reason}` };
}

// What happens next after an action, in words.
export function nextStep(kind: string, action: DeadLetterAction): string {
  const words = own(KINDS, kind)?.next[action];
  if (words) return words;
  return {
    retry: "Sent back to be tried again.",
    skip: "Skipped; it won't be tried again.",
    hand_off: "Handed off for you to do by hand.",
  }[action];
}

// The message for an API refusal code; already resolved counts as done (a resolve is once only).
export function resolveMessage(code: unknown): string {
  if (code === "already_resolved") return "That was already resolved.";
  if (code === "not_found") return "That letter isn't there any more. Reload the page.";
  if (code === "unauthenticated") return "You've been signed out. Sign in again.";
  return "That didn't work. Try again.";
}
