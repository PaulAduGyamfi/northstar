import { z } from "zod";
import { APPLY_ATS, type ApplyAts } from "./apply-package.js";

// What a web push carries (NS-193, ADR-0032 item 4): a kind, an id and codes from fixed lists,
// nothing else. Never a URL, company, job title, email text or anything Paul typed: push
// services and the lock screen may show what a push holds, and only fixed words are ever shown.
// Each later kind (#172, #180) adds a member here with its own fixed words.

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

export const PushPayload = z.discriminatedUnion("kind", [HandoffPush]);
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

// The notification's words: fixed sentences chosen by codes. `tag` lets a repeated push replace
// the earlier notification instead of stacking. The service worker keeps a copy of these words
// (apps/web/public/sw.js, slice 2, with a test that they agree).
export function pushWords(payload: PushPayload): PushWords {
  return {
    title: "Needs your hands",
    body: `${ATS_FORM[payload.ats]} stopped at ${CHALLENGE[payload.reason]}. Open Northstar to finish it.`,
    tag: `handoff:${payload.id}`,
  };
}
