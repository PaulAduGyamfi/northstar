import { z } from "zod";

// A prep plan as the Queue shows it before Paul approves it (NS-241 slice 6, CAL-003): the API's
// GET /approvals/prep-plan answer, and its lines in words. Times are shown in the zone given
// (the browser's own), so Paul reads them as his calendar will.

const Interval = z.object({ start: z.string(), end: z.string() });

export const PrepPlanBody = z.object({
  interview: Interval,
  blocks: z.array(Interval.extend({ kind: z.enum(["prep", "warm_up"]) })),
  rescheduled: z.boolean(),
});
export type PrepPlanBody = z.infer<typeof PrepPlanBody>;

const BLOCK_WORDS: Record<PrepPlanBody["blocks"][number]["kind"], string> = {
  prep: "Prep",
  warm_up: "Warm-up",
};

export const RESCHEDULED_LINE =
  "The interview moved after this plan was made: reject it, and the next funnel prep plans for the new time.";

// "Tue, Dec 1, 10:00" in the given zone, 24-hour, so no AM/PM to misread.
function dayAndTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

function timeOnly(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

// The interview first, then each block in time order, then the rescheduled warning when set.
export function prepPlanLines(plan: PrepPlanBody, timeZone: string): string[] {
  const lines = [`Interview: ${dayAndTime(plan.interview.start, timeZone)}`];
  const blocks = [...plan.blocks].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  if (blocks.length === 0) lines.push("No prep blocks fit before this interview.");
  for (const b of blocks) {
    lines.push(
      `${BLOCK_WORDS[b.kind]}: ${dayAndTime(b.start, timeZone)}-${timeOnly(b.end, timeZone)}`,
    );
  }
  if (plan.rescheduled) lines.push(RESCHEDULED_LINE);
  return lines;
}
