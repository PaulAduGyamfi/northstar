import { z } from "zod";

// The Grow tab (NS-214, GRW-005…007): the API's answer and the plain words it is shown in.
// Progress is counted, never shamed (UX-032): no "broken streak", "missed" or "behind" copy.

const Row = z.object({
  key: z.string(),
  name: z.string(),
  type: z.enum(["project", "course", "cert", "skill"]),
  status: z.enum(["active", "paused", "backlogged", "done"]),
  minutesThisWeek: z.number(),
  plannedMinutes: z.number(),
  daysSinceTouched: z.number().nullable(),
  atRisk: z.boolean(),
  streakWeeks: z.number(),
  percent: z.number().nullable(),
  percentPerWeekNeeded: z.number().nullable(),
});
export type GrowRow = z.infer<typeof Row>;

export const ReviewBody = z.object({
  weekStart: z.string(),
  moved: z.array(
    z.object({
      key: z.string(),
      name: z.string().nullable(),
      minutes: z.number(),
      plannedMinutes: z.number(),
    }),
  ),
  notReached: z.array(z.object({ key: z.string(), name: z.string().nullable() })),
});
export type ReviewView = z.infer<typeof ReviewBody>;

export const GrowBody = z.object({
  weekStart: z.string(),
  planStored: z.boolean(),
  tracks: z.array(Row),
  lastWeek: z.object({ weekStart: z.string(), review: ReviewBody.nullable() }),
});
export type GrowView = z.infer<typeof GrowBody>;

const TYPE_WORDS: Record<GrowRow["type"], string> = {
  project: "Project",
  course: "Course",
  cert: "Certification",
  skill: "Skill",
};

const STATUS_WORDS: Record<GrowRow["status"], string> = {
  active: "Active",
  paused: "Paused",
  backlogged: "In the backlog",
  done: "Done",
};

export type TrackCard = {
  key: string;
  name: string;
  kind: string;
  status: string;
  minutes: string;
  touched: string;
  // Each is shown only when it has something to say.
  atRisk: string | null;
  streak: string | null;
  percent: number | null;
  pace: string | null;
};

const days = (n: number) => (n === 1 ? "1 day" : `${n} days`);

// One track's card, every status in words.
export function trackCard(row: GrowRow): TrackCard {
  return {
    key: row.key,
    name: row.name,
    kind: TYPE_WORDS[row.type],
    status: STATUS_WORDS[row.status],
    minutes:
      row.plannedMinutes > 0
        ? `${row.minutesThisWeek} of ${row.plannedMinutes} min this week`
        : `${row.minutesThisWeek} min this week, none planned`,
    touched:
      row.daysSinceTouched === null
        ? "Not worked on yet"
        : row.daysSinceTouched === 0
          ? "Last worked on today"
          : `Last worked on ${days(row.daysSinceTouched)} ago`,
    atRisk: row.atRisk ? "At risk: it goes first in next week's plan" : null,
    streak:
      row.streakWeeks > 0
        ? `${row.streakWeeks === 1 ? "1 week" : `${row.streakWeeks} weeks`} in a row`
        : null,
    percent: row.percent,
    pace:
      row.percentPerWeekNeeded === null
        ? null
        : `${row.percentPerWeekNeeded}% a week reaches the target date`,
  };
}

// A review's plain lines: what moved, then what wasn't reached (never "missed").
export function reviewLines(review: ReviewView): string[] {
  const label = (key: string, name: string | null) => name ?? `${key} (no longer a track)`;
  return [
    ...review.moved.map(
      (m) =>
        `${label(m.key, m.name)}: ${m.minutes} ${
          m.plannedMinutes > 0 ? `of ${m.plannedMinutes} ` : ""
        }min`,
    ),
    ...review.notReached.map((n) => `${label(n.key, n.name)}: not reached this week`),
  ];
}

// What each refusal from the Grow endpoints means, in plain words.
export const GROW_MESSAGES: Record<string, string> = {
  unknown_track: "That track isn't in your current tracks file. Reload the page.",
  invalid_input: "Minutes must be 1 to 600, and the percent 0 to 100.",
  no_plan:
    "Last week had no stored plan, so there's nothing to review. Run profile growth plan each week.",
  unavailable: "Northstar couldn't save that right now. Try again.",
  unauthenticated: "You've been signed out. Sign in again.",
};

// The message for an API refusal code; anything unknown gets a plain retry.
export const growMessage = (code: unknown): string =>
  typeof code === "string" && code in GROW_MESSAGES
    ? (GROW_MESSAGES[code] as string)
    : "That didn't work. Try again.";

// A check-in's body from the form's fields, or null when they don't make one.
export function checkInBody(
  fields: { key: string; minutes: string; percent: string },
  idempotencyKey: string,
): { key: string; minutes: number; percent: number | null; idempotencyKey: string } | null {
  const minutes = /^\d{1,3}$/.test(fields.minutes.trim()) ? Number(fields.minutes) : Number.NaN;
  const rawPercent = fields.percent.trim();
  const percent = rawPercent === "" ? null : Number(rawPercent);
  if (fields.key === "" || !(minutes >= 1 && minutes <= 600)) return null;
  if (percent !== null && !(Number.isFinite(percent) && percent >= 0 && percent <= 100)) {
    return null;
  }
  return { key: fields.key, minutes, percent, idempotencyKey };
}
