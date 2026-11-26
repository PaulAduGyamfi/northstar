import { describe, expect, it } from "vitest";
import { type PrepInterval, planPrepBlocks, reminderTimes } from "./interview-prep.js";

const at = (iso: string) => new Date(iso);
const span = (start: string, end: string): PrepInterval => ({ start: at(start), end: at(end) });
const iso = (i: PrepInterval | null) => (i ? [i.start.toISOString(), i.end.toISOString()] : null);

// Thursday 15 January 2026, 15:00 in Toronto (EST, UTC-5), working hours 09:00-17:00.
const base = {
  interview: span("2026-01-15T20:00:00Z", "2026-01-15T21:00:00Z"),
  busy: [] as PrepInterval[],
  workingHours: { start: 9 * 60, end: 17 * 60 },
  timeZone: "America/Toronto",
  now: at("2026-01-10T00:00:00Z"),
};

describe("planPrepBlocks", () => {
  it("places one block on each of the two nearest days at the start of working hours", () => {
    const plan = planPrepBlocks(base);
    expect(plan.blocks.map(iso)).toEqual([
      ["2026-01-14T14:00:00.000Z", "2026-01-14T14:45:00.000Z"],
      ["2026-01-15T14:00:00.000Z", "2026-01-15T14:45:00.000Z"],
    ]);
    expect(iso(plan.warmUp)).toEqual(["2026-01-15T19:00:00.000Z", "2026-01-15T19:15:00.000Z"]);
    expect(plan.missingPrep).toBe(0);
    expect(plan.warmUpMissing).toBe(false);
  });

  it("moves a block to the first free quarter hour after a busy morning", () => {
    const plan = planPrepBlocks({
      ...base,
      busy: [span("2026-01-15T14:00:00Z", "2026-01-15T15:10:00Z")],
    });
    expect(iso(plan.blocks[1] ?? null)).toEqual([
      "2026-01-15T15:15:00.000Z",
      "2026-01-15T16:00:00.000Z",
    ]);
  });

  it("moves a block to an earlier day when a whole day is busy", () => {
    const plan = planPrepBlocks({
      ...base,
      busy: [span("2026-01-14T00:00:00Z", "2026-01-15T00:00:00Z")],
    });
    expect(plan.blocks.map((b) => b.start.toISOString())).toEqual([
      "2026-01-13T14:00:00.000Z",
      "2026-01-15T14:00:00.000Z",
    ]);
  });

  it("puts both blocks on the same day when it is the only free one, without overlap", () => {
    const plan = planPrepBlocks({
      ...base,
      busy: [span("2026-01-12T00:00:00Z", "2026-01-15T05:00:00Z")],
    });
    expect(plan.blocks.map((b) => b.start.toISOString())).toEqual([
      "2026-01-15T14:00:00.000Z",
      "2026-01-15T14:45:00.000Z",
    ]);
  });

  it("reports every block as missing when every day is busy, and never shortens one", () => {
    const plan = planPrepBlocks({
      ...base,
      busy: [span("2026-01-12T00:00:00Z", "2026-01-15T19:00:00Z")],
    });
    expect(plan.blocks).toEqual([]);
    expect(plan.missingPrep).toBe(2);
    // A busy time that ends as the warm-up starts doesn't block it.
    expect(plan.warmUpMissing).toBe(false);
  });

  it("follows the time zone's summer offset", () => {
    // Wednesday 15 July 2026, 15:00 in Toronto (EDT, UTC-4): 09:00 local is 13:00 UTC.
    const plan = planPrepBlocks({
      ...base,
      interview: span("2026-07-15T19:00:00Z", "2026-07-15T20:00:00Z"),
      now: at("2026-07-01T00:00:00Z"),
    });
    expect(plan.blocks.map((b) => b.start.toISOString())).toEqual([
      "2026-07-14T13:00:00.000Z",
      "2026-07-15T13:00:00.000Z",
    ]);
  });

  it("moves working hours with the clock across a daylight-saving change", () => {
    // Clocks went forward on Sunday 8 March 2026; the interview is Monday 9 March, 15:00 EDT.
    const plan = planPrepBlocks({
      ...base,
      interview: span("2026-03-09T19:00:00Z", "2026-03-09T20:00:00Z"),
      busy: [span("2026-03-09T00:00:00Z", "2026-03-09T18:00:00Z")],
      now: at("2026-03-01T00:00:00Z"),
    });
    // 09:00 EST on Saturday is 14:00 UTC; 09:00 EDT on Sunday is 13:00 UTC.
    expect(plan.blocks.map((b) => b.start.toISOString())).toEqual([
      "2026-03-07T14:00:00.000Z",
      "2026-03-08T13:00:00.000Z",
    ]);
  });

  it("drops the warm-up when its time is busy", () => {
    const plan = planPrepBlocks({
      ...base,
      busy: [span("2026-01-15T19:10:00Z", "2026-01-15T19:30:00Z")],
    });
    expect(plan.warmUp).toBeNull();
    expect(plan.warmUpMissing).toBe(true);
  });

  it("never plans a block that overlaps the interview or ends inside its last hour", () => {
    // Working hours reach past the interview's start.
    const plan = planPrepBlocks({
      ...base,
      workingHours: { start: 14 * 60, end: 18 * 60 },
      now: at("2026-01-15T19:00:00Z"),
    });
    expect(plan.blocks).toEqual([]);
    expect(plan.missingPrep).toBe(2);
  });

  it("plans nothing before now, so a late plan gets only the blocks still ahead", () => {
    const plan = planPrepBlocks({ ...base, now: at("2026-01-15T18:00:00Z") });
    expect(plan.blocks.map(iso)).toEqual([
      ["2026-01-15T18:00:00.000Z", "2026-01-15T18:45:00.000Z"],
    ]);
    expect(plan.missingPrep).toBe(1);
  });

  it("keeps a block that ends exactly an hour before the interview", () => {
    const plan = planPrepBlocks({ ...base, now: at("2026-01-15T18:15:00Z") });
    expect(plan.blocks.map(iso)).toEqual([
      ["2026-01-15T18:15:00.000Z", "2026-01-15T19:00:00.000Z"],
    ]);
  });

  it("accepts a block ending at midnight but never one that crosses it", () => {
    // Working hours 23:00-24:00 in Toronto: 04:00-05:00 UTC the next day.
    const plan = planPrepBlocks({
      ...base,
      workingHours: { start: 23 * 60, end: 1440 },
      busy: [span("2026-01-14T04:00:00Z", "2026-01-14T04:15:00Z")],
    });
    // 13 January's evening: 04:15 UTC would end at 05:00 (midnight), so it fits; on the 14th
    // the 04:00 slot is free.
    expect(plan.blocks.map((b) => b.start.toISOString())).toEqual([
      "2026-01-14T04:15:00.000Z",
      "2026-01-15T04:00:00.000Z",
    ]);
  });

  it("refuses a busy time with an invalid date", () => {
    expect(() =>
      planPrepBlocks({
        ...base,
        busy: [{ start: new Date("nope"), end: at("2026-01-15T00:00:00Z") }],
      }),
    ).toThrow("invalid date");
  });

  it("drops a warm-up whose time has passed", () => {
    const plan = planPrepBlocks({ ...base, now: at("2026-01-15T19:05:00Z") });
    expect(plan.warmUpMissing).toBe(true);
    expect(plan.missingPrep).toBe(2);
  });

  it("refuses an unknown time zone", () => {
    expect(() => planPrepBlocks({ ...base, timeZone: "Mars/Olympus_Mons" })).toThrow(RangeError);
  });

  it("refuses working hours that don't make a range", () => {
    expect(() => planPrepBlocks({ ...base, workingHours: { start: 600, end: 600 } })).toThrow(
      "bad working hours",
    );
    expect(() => planPrepBlocks({ ...base, workingHours: { start: 0, end: 1500 } })).toThrow(
      "bad working hours",
    );
  });

  it("refuses an interview that ends before it starts", () => {
    expect(() =>
      planPrepBlocks({ ...base, interview: span("2026-01-15T20:00:00Z", "2026-01-15T19:00:00Z") }),
    ).toThrow("interview must end after it starts");
  });
});

describe("reminderTimes", () => {
  const start = at("2026-01-15T20:00:00Z");

  it("gives the day-before and hour-before reminders", () => {
    expect(reminderTimes(start, at("2026-01-10T00:00:00Z"))).toEqual([
      { kind: "day_before", at: at("2026-01-14T20:00:00Z") },
      { kind: "hour_before", at: at("2026-01-15T19:00:00Z") },
    ]);
  });

  it("drops a reminder whose time has already passed", () => {
    expect(reminderTimes(start, at("2026-01-15T08:00:00Z"))).toEqual([
      { kind: "hour_before", at: at("2026-01-15T19:00:00Z") },
    ]);
    expect(reminderTimes(start, at("2026-01-15T19:30:00Z"))).toEqual([]);
  });
});
