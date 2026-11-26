// Interview prep (NS-170, CAL-003/004), slice 1: the prep blocks Northstar proposes before an
// interview and the reminder times. Plain code, no model, no I/O: it proposes and never writes.
// Writing a block to the calendar goes through the Approval Gate later (ADR-0002, ADR-0026).

const MINUTE = 60_000;
// CAL-003's default prep: 2 × 45 minutes in the 3 days before, and a 15-minute warm-up 1 hour
// before.
export const PREP_BLOCKS = 2;
export const PREP_MINUTES = 45;
export const PREP_DAYS = 3;
export const WARM_UP_MINUTES = 15;
export const WARM_UP_LEAD_MINUTES = 60;
// Blocks start on a quarter-hour grid, so proposals read like times a person would pick.
const GRID_MINUTES = 15;

export type PrepInterval = { start: Date; end: Date };

export type PrepInput = {
  interview: PrepInterval;
  // Paul's busy time (other events, growth blocks). Touching ends don't overlap.
  busy: readonly PrepInterval[];
  // Minutes after local midnight in `timeZone`; start before end.
  workingHours: { start: number; end: number };
  timeZone: string;
  now: Date;
};

export type PrepPlan = {
  blocks: PrepInterval[];
  warmUp: PrepInterval | null;
  // How many of the PREP_BLOCKS couldn't be placed; never shortened or forced.
  missingPrep: number;
  warmUpMissing: boolean;
};

const validDate = (d: Date) => d instanceof Date && !Number.isNaN(d.getTime());

// Half-open intervals: [a, b) and [c, d) overlap only when each starts before the other ends.
const overlaps = (a: PrepInterval, b: PrepInterval) =>
  a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();

// The local date and minute of `at` in the zone. Each time is converted on its own, so a
// daylight-saving shift moves working hours with the clock.
function localTime(format: Intl.DateTimeFormat, at: Date) {
  const parts = format.formatToParts(at);
  const get = (type: string) => {
    const value = parts.find((p) => p.type === type)?.value;
    // Intl always gives these parts; a missing one must not quietly read as minute 0.
    if (value === undefined) throw new Error("missing time part");
    return value;
  };
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    minute: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function checkInput(input: PrepInput): Intl.DateTimeFormat {
  const { interview, busy, workingHours: wh, now } = input;
  if (!validDate(interview.start) || !validDate(interview.end) || !validDate(now)) {
    throw new Error("invalid date");
  }
  if (interview.end.getTime() <= interview.start.getTime()) {
    throw new Error("interview must end after it starts");
  }
  if (busy.some((b) => !validDate(b.start) || !validDate(b.end))) throw new Error("invalid date");
  if (
    !Number.isInteger(wh.start) ||
    !Number.isInteger(wh.end) ||
    wh.start < 0 ||
    wh.end > 1440 ||
    wh.start >= wh.end
  ) {
    throw new Error("bad working hours");
  }
  // An unknown zone throws a RangeError here: the caller's bug, never a silent UTC plan.
  return new Intl.DateTimeFormat("en-US", {
    timeZone: input.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

// CAL-003: the default prep plan for one interview. The same input always gives the same plan.
export function planPrepBlocks(input: PrepInput): PrepPlan {
  const format = checkInput(input);
  const { interview, busy, workingHours: wh, now } = input;
  const startMs = interview.start.getTime();
  const taken: PrepInterval[] = [interview, ...busy];

  // The grid is on UTC milliseconds; it is also the local quarter-hour grid because every time
  // zone's offset is a multiple of 15 minutes (+05:30, +05:45, +12:45 included).
  // Candidate starts: on the grid, not before now or the 3-day window, and ending at least the
  // warm-up's lead before the interview.
  const grid = GRID_MINUTES * MINUTE;
  const from = Math.max(now.getTime(), startMs - PREP_DAYS * 1440 * MINUTE);
  const lastStart = startMs - (WARM_UP_LEAD_MINUTES + PREP_MINUTES) * MINUTE;
  const byDay = new Map<string, PrepInterval[]>();
  for (let t = Math.ceil(from / grid) * grid; t <= lastStart; t += grid) {
    const block = { start: new Date(t), end: new Date(t + PREP_MINUTES * MINUTE) };
    const first = localTime(format, block.start);
    // The block's last minute, so a block ending exactly at working hours' end fits.
    const last = localTime(format, new Date(block.end.getTime() - MINUTE));
    // first <= last: when clocks fall back inside a block, its local time runs backwards, and a
    // block starting outside working hours could otherwise look inside them.
    const inHours =
      first.day === last.day &&
      first.minute <= last.minute &&
      first.minute >= wh.start &&
      last.minute < wh.end;
    if (!inHours || taken.some((b) => overlaps(block, b))) continue;
    const list = byDay.get(first.day) ?? [];
    list.push(block);
    byDay.set(first.day, list);
  }

  // Days nearest the interview first (Map keeps insertion order, oldest first). One block per
  // day, then a second pass fills a day twice if days ran out.
  const days = [...byDay.values()].reverse();
  const blocks: PrepInterval[] = [];
  for (let pass = 0; pass < 2 && blocks.length < PREP_BLOCKS; pass++) {
    for (const candidates of days) {
      if (blocks.length >= PREP_BLOCKS) break;
      const pick = candidates.find((c) => !blocks.some((b) => overlaps(c, b)));
      if (pick && (pass === 1 || !blocks.some((b) => candidates.includes(b)))) blocks.push(pick);
    }
  }
  blocks.sort((a, b) => a.start.getTime() - b.start.getTime());

  // The warm-up: working hours don't apply, but it must be free and still ahead.
  const warm = {
    start: new Date(startMs - WARM_UP_LEAD_MINUTES * MINUTE),
    end: new Date(startMs - (WARM_UP_LEAD_MINUTES - WARM_UP_MINUTES) * MINUTE),
  };
  const warmOk = warm.start.getTime() >= now.getTime() && !busy.some((b) => overlaps(warm, b));

  return {
    blocks,
    warmUp: warmOk ? warm : null,
    missingPrep: PREP_BLOCKS - blocks.length,
    warmUpMissing: !warmOk,
  };
}

export type Reminder = { kind: "day_before" | "hour_before"; at: Date };

// CAL-004: the day-before (24 hours) and hour-before reminders. A time already past is dropped.
export function reminderTimes(interviewStart: Date, now: Date): Reminder[] {
  if (!validDate(interviewStart) || !validDate(now)) throw new Error("invalid date");
  const start = interviewStart.getTime();
  const all: Reminder[] = [
    { kind: "day_before", at: new Date(start - 1440 * MINUTE) },
    { kind: "hour_before", at: new Date(start - 60 * MINUTE) },
  ];
  return all.filter((r) => r.at.getTime() >= now.getTime());
}
