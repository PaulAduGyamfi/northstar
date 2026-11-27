import { z } from "zod";

// "Needs your hands" on Today (NS-121, APPLY-006, ACC-007): the applications a CAPTCHA, sign-in
// or verification step stopped, from the API's GET /handoffs, and the plain decisions about how
// each shows. Northstar never solves a challenge (ADR-0003); Paul opens the page himself.

const Item = z.object({
  handoffId: z.string(),
  applicationId: z.string(),
  ats: z.string(),
  reason: z.string(),
  applyUrl: z.string(),
  createdAt: z.string(),
});
export type HandoffItem = z.infer<typeof Item>;
export const HandoffsBody = z.object({ items: z.array(Item) });

export type HandoffCard = { handoffId: string; title: string; href: string | null };

// The challenge codes (NEEDS_HUMAN_REASONS) in plain words.
const REASONS: Record<string, string> = {
  captcha: "a CAPTCHA",
  login: "a sign-in",
  mfa: "a verification code",
  account: "an account sign-up",
};

// Only an https link is ever put in an href: the API and the database refuse anything else, and
// this is the last check before the page, so a `javascript:` link can never run here.
export function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

const ATS_NAME = /^[a-z][a-z0-9]*$/;

export function handoffCards(items: HandoffItem[]): HandoffCard[] {
  return items.map((h) => {
    const form = ATS_NAME.test(h.ats)
      ? `${h.ats[0]?.toUpperCase()}${h.ats.slice(1)}`
      : "Application";
    const why = REASONS[h.reason] ?? "a check only you can pass";
    return { handoffId: h.handoffId, title: `${form} form: ${why}`, href: safeHref(h.applyUrl) };
  });
}

// The pre-fill code (NS-192 slice 4, ADR-0030): what POST /handoffs/prefill-grant answers, and
// the one string Paul copies into the extension popup. The extension's parsePrefillCode reads
// exactly this shape (handoff UUID, a dot, the 43-character grant): change both together.
export const GrantBody = z.object({
  grant: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.string(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function prefillCode(handoffId: string, grant: string): string | null {
  if (!UUID.test(handoffId) || !/^[A-Za-z0-9_-]{43}$/.test(grant)) return null;
  return `${handoffId}.${grant}`;
}

// Whole seconds left until the grant expires, never below 0 (an unreadable time is 0).
export function secondsLeft(expiresAt: string, now: number): number {
  const end = Date.parse(expiresAt);
  if (Number.isNaN(end)) return 0;
  return Math.max(0, Math.ceil((end - now) / 1000));
}

// "1:05" for the countdown.
export function countdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// The grant endpoint's refusals (apps/api/src/prefill.ts) in plain words.
const GRANT_REFUSALS: Record<string, string> = {
  not_found: "Northstar doesn't know that handoff.",
  closed: "That handoff is already closed.",
  no_package: "There is no approved package to pre-fill for this application.",
  not_approved:
    "The approval behind this application is no longer live, so it can't be pre-filled.",
  changed: "The package changed after you approved it, so it can't be pre-filled.",
};

export function grantMessage(status: number, error: string | null): string {
  if (status === 401) return "You've been signed out. Sign in again.";
  return (error !== null && GRANT_REFUSALS[error]) || "Couldn't get a pre-fill code. Try again.";
}
