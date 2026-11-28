import { z } from "zod";
import { APPLY_ATS, type ApplyAts } from "./apply-package.js";

// What a web push carries (NS-193, ADR-0032 item 4): a kind, an id and codes from fixed lists,
// nothing else. Never a URL, company, job title, email text or anything Paul typed: push
// services and the lock screen may show what a push holds, and only fixed words are ever shown.
// Each later kind (#180) adds a member here with its own fixed words.

// The challenges a handoff opens for (CHALLENGE_REASONS in packages/db, ADR-0003).
export const PUSH_CHALLENGES = ["captcha", "login", "mfa", "account"] as const;
export type PushChallenge = (typeof PUSH_CHALLENGES)[number];

// A push's JSON is small and fixed in shape: anything longer is not one of ours.
export const MAX_PUSH_PAYLOAD_BYTES = 256;

const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

// A new open handoff (NS-193): which ATS form stopped and why. `strict` refuses any other key, so
// no field can smuggle a URL or a name in.
export const HandoffPush = z
  .object({
    v: z.literal(1),
    kind: z.literal("handoff"),
    id: Uuid,
    ats: z.enum(APPLY_ATS),
    reason: z.enum(PUSH_CHALLENGES),
  })
  .strict();
export type HandoffPush = z.infer<typeof HandoffPush>;

// The oldest age a fresh-job push names: an alert is for a job under an hour old, but one held for
// quiet hours goes out later (packages/sources alerts.ts), so a day is the bound.
export const MAX_FRESH_AGE_MINUTES = 24 * 60;

// A fresh-job alert (NS-199 item 1, SRC-015): the job's id, its age at the alert in whole minutes
// and its fit score, the numbers the feed line shows. Never a title, company, place or URL.
export const FreshJobPush = z
  .object({
    v: z.literal(1),
    kind: z.literal("fresh_job"),
    id: Uuid,
    age: z.number().int().min(0).max(MAX_FRESH_AGE_MINUTES),
    fit: z.number().int().min(0).max(100),
  })
  .strict();
export type FreshJobPush = z.infer<typeof FreshJobPush>;

export const PushPayload = z.discriminatedUnion("kind", [HandoffPush, FreshJobPush]);
export type PushPayload = z.infer<typeof PushPayload>;

// The payload as the sender encrypts it, or null when it isn't one of ours or is too long.
export function encodePushPayload(payload: unknown): string | null {
  const parsed = PushPayload.safeParse(payload);
  if (!parsed.success) return null;
  // Re-serialized from the parsed value, so key order and content are ours, not the caller's.
  const json = JSON.stringify(parsed.data);
  return Buffer.byteLength(json, "utf8") <= MAX_PUSH_PAYLOAD_BYTES ? json : null;
}

// The ATS names and challenges in the feed's own words (feed.ts, `handoff.opened`).
const ATS_FORM: Record<ApplyAts, string> = {
  greenhouse: "A Greenhouse form",
  lever: "A Lever form",
  ashby: "An Ashby form",
  smartrecruiters: "A Smartrecruiters form",
};
const CHALLENGE: Record<PushChallenge, string> = {
  captcha: "a CAPTCHA",
  login: "a sign-in",
  mfa: "a verification code",
  account: "an account sign-up",
};

export type PushWords = { title: string; body: string; tag: string };

// "12 min ago" under an hour, then whole hours, then whole days: the fresh-job feed line's words
// (packages/db alert-write.ts re-exports it), so a push and its feed line read the same.
export function ageText(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h ago`;
  return `${Math.floor(m / (24 * 60))} days ago`;
}

// The notification's words: fixed sentences chosen by codes and numbers. `tag` lets a repeated
// push replace the earlier notification instead of stacking. The service worker keeps a copy of
// these words (apps/web/public/sw.js, with a test that they agree).
export function pushWords(payload: PushPayload): PushWords {
  if (payload.kind === "fresh_job") {
    return {
      title: "A fresh job fits you",
      // The feed line's own numbers ("Posted 12 min ago · Fit 88"), never the job's name.
      body: `Posted ${ageText(payload.age)} · Fit ${payload.fit}. Open Northstar to see it.`,
      tag: `fresh_job:${payload.id}`,
    };
  }
  return {
    title: "Needs your hands",
    body: `${ATS_FORM[payload.ats]} stopped at ${CHALLENGE[payload.reason]}. Open Northstar to finish it.`,
    tag: `handoff:${payload.id}`,
  };
}
