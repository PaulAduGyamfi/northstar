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
