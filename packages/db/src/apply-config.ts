import { z } from "zod";

// The Apply Gateway's pacing limits (APPLY-007, NS-143). The one place they come from: a caller
// of claimSubmission can't pass its own numbers, only an ApplyLimits value, and the only ways to
// make one are DEFAULT_APPLY_LIMITS and loadApplyLimits. The settings may lower the limits but
// never raise them past APPLY-007's defaults, which exist to protect Paul's reputation.

// APPLY-007 defaults: at most 25 started in any 24 hours, 90 s between two on the same ATS.
export const DEFAULT_DAILY_CAP = 25;
export const DEFAULT_MIN_GAP_MS = 90_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const Limits = z
  .object({
    dailyCap: z.number().int().min(1).max(DEFAULT_DAILY_CAP),
    // Below a day, so a gap can never stop the daily cap from freeing up.
    minGapMs: z.number().int().min(DEFAULT_MIN_GAP_MS).max(DAY_MS),
  })
  .brand<"ApplyLimits">();
export type ApplyLimits = z.infer<typeof Limits>;

export const DEFAULT_APPLY_LIMITS: ApplyLimits = Limits.parse({
  dailyCap: DEFAULT_DAILY_CAP,
  minGapMs: DEFAULT_MIN_GAP_MS,
});

// A whole number written in decimal digits, or unset (then the default holds).
const Setting = z
  .string()
  .regex(/^[0-9]+$/)
  .transform(Number)
  .optional();

// Reads APPLY_DAILY_CAP (a count) and APPLY_MIN_GAP_SECONDS from the environment the entry point
// passes in. Throws naming the setting and its allowed range; the values aren't secret, but the
// message stays the same whatever was written.
export function loadApplyLimits(env: Record<string, string | undefined>): ApplyLimits {
  const cap = Setting.safeParse(env.APPLY_DAILY_CAP);
  const parsedCap = cap.success
    ? Limits.shape.dailyCap.safeParse(cap.data ?? DEFAULT_DAILY_CAP)
    : null;
  if (!parsedCap?.success) {
    throw new Error(`APPLY_DAILY_CAP must be a whole number from 1 to ${DEFAULT_DAILY_CAP}`);
  }
  const gap = Setting.safeParse(env.APPLY_MIN_GAP_SECONDS);
  const parsedGap = gap.success
    ? Limits.shape.minGapMs.safeParse(gap.data === undefined ? DEFAULT_MIN_GAP_MS : gap.data * 1000)
    : null;
  if (!parsedGap?.success) {
    throw new Error(
      `APPLY_MIN_GAP_SECONDS must be a whole number from ${DEFAULT_MIN_GAP_MS / 1000} to ${DAY_MS / 1000}`,
    );
  }
  return Limits.parse({ dailyCap: parsedCap.data, minGapMs: parsedGap.data });
}

// The brand only exists for the type checker: a cast can forge it. claimSubmission re-checks
// the bounds at run time with this, so forged limits throw instead of raising the cap.
export function checkApplyLimits(limits: ApplyLimits): ApplyLimits {
  const parsed = Limits.safeParse(limits);
  if (!parsed.success) {
    throw new Error("apply limits must be a cap from 1 to 25 and a gap from 90 s to a day");
  }
  return parsed.data;
}
