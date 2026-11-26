import { z } from "zod";

// Model spend on Health (NS-219, RES-009, ADR-0021): the API's spend against the caps and the
// route priorities held back now, in plain words. Which routes each priority covers mirrors the
// routes' own `priority` (low: mail-classify; fresh: job-extract, job-match,
// verification-extract; normal: the rest).

export const SpendBody = z.object({
  todayUsd: z.number(),
  monthUsd: z.number(),
  dailyCapUsd: z.number().nullable(),
  monthlyCapUsd: z.number().nullable(),
  paused: z.array(
    z.object({
      priority: z.enum(["low", "normal", "fresh"]),
      cap: z.enum(["daily", "monthly"]),
    }),
  ),
});
export type Spend = z.infer<typeof SpendBody>;

const WORK = {
  low: "sorting job mail",
  normal: "drafting and other model work",
  fresh: "reading new postings, matching jobs and verification emails",
} as const;

// The share of a cap each priority may reach (ADR-0021's HOLD_AT), in words.
const SHARE = { low: "80% of the", normal: "the", fresh: "125% of the" } as const;

const dollars = (usd: number) => `$${usd.toFixed(2)}`;

const usageLine = (label: string, spent: number, cap: number | null, kind: string) =>
  cap === null
    ? `${label}: ${dollars(spent)} (no ${kind} cap)`
    : `${label}: ${dollars(spent)} of the ${dollars(cap)} ${kind} cap`;

// Usage lines, one line per paused priority, and a one-line summary.
export function spendView(s: Spend): { usage: string[]; paused: string[]; summary: string } {
  const paused = s.paused.map(({ priority, cap }) => {
    const when = cap === "daily" ? "Today's" : "This month's";
    const resumes = cap === "daily" ? "tomorrow (UTC)" : "next month (UTC)";
    return `Paused: ${WORK[priority]}. ${when} spend reached ${SHARE[priority]} ${cap} cap. It starts again ${resumes}, or sooner if you raise the cap.`;
  });
  return {
    usage: [
      usageLine("Today", s.todayUsd, s.dailyCapUsd, "daily"),
      usageLine("This month", s.monthUsd, s.monthlyCapUsd, "monthly"),
    ],
    paused,
    summary:
      paused.length === 0 ? "Nothing is paused." : "Some model work is paused by the spend cap.",
  };
}
