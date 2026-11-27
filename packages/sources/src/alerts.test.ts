import type { AlertCandidate, StoredAlertSettings } from "@northstar/db";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type AlertConfig,
  type AlertStore,
  alertPass,
  decideAlert,
  FRESH_MINUTES,
  freshSince,
  inQuietHours,
  jobTier,
  loadAlertConfig,
  scoreThenAlert,
  type WatchedBoard,
} from "./alerts.js";

// Synthetic jobs and boards only.

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
beforeEach(() => exporter.reset());

const config: AlertConfig = {
  quiet: { start: 22 * 60, end: 7 * 60 },
  timeZone: "UTC",
  tier1InQuietHours: true,
};
const DAY = new Date("2026-11-25T12:00:00Z");
const NIGHT = new Date("2026-11-25T23:30:00Z");
const MORNING = new Date("2026-11-26T07:05:00Z");

const watches: WatchedBoard[] = [
  { ats: "greenhouse", board: "globex", tier: 1 },
  { ats: "lever", board: "initech", tier: 2 },
];

function candidate(over: Partial<AlertCandidate> = {}, postedMinutesBefore = 12, at = DAY) {
  return {
    jobId: "job-1",
    postedAt: new Date(at.getTime() - postedMinutesBefore * 60_000),
    firstSeenAt: at,
    score: 88,
    sourceUrls: ["https://boards.greenhouse.io/acme/jobs/123"],
    alerted: false,
    held: false,
    ...over,
  } satisfies AlertCandidate;
}

// A store over an in-memory list, keyed per job like packages/db, recording every call.
function memoryStore(list: AlertCandidate[]) {
  const alerts: unknown[] = [];
  const holds: unknown[] = [];
  const store: AlertStore = {
    candidates: async () =>
      list.map((c) => ({
        ...c,
        alerted: c.alerted || alerts.some((a) => (a as { jobId: string }).jobId === c.jobId),
        held: c.held || holds.some((h) => (h as { jobId: string }).jobId === c.jobId),
      })),
    watches: async () => watches,
    alert: async (input) => {
      if (alerts.some((a) => (a as { jobId: string }).jobId === input.jobId)) return "exists";
      alerts.push(input);
      return "recorded";
    },
    hold: async (input) => {
      if (holds.some((h) => (h as { jobId: string }).jobId === input.jobId)) return "exists";
      holds.push(input);
      return "recorded";
    },
  };
  return { store, alerts, holds };
}

describe("alertPass", () => {
  it("sends exactly one alert for a fresh high-fit job, even when the pass runs twice", async () => {
    const { store, alerts } = memoryStore([candidate()]);
    expect(await alertPass(store, DAY, config)).toEqual({ sent: 1, held: 0, released: 0 });
    expect(await alertPass(store, DAY, config)).toEqual({ sent: 0, held: 0, released: 0 });
    expect(alerts).toEqual([
      { jobId: "job-1", score: 88, ageMinutes: 12, tier: null, now: DAY, wasHeld: false },
    ]);
  });

  it("counts a posting dated in the future as just posted", async () => {
    const { store, alerts } = memoryStore([candidate({}, -30)]);
    expect(await alertPass(store, DAY, config)).toEqual({ sent: 1, held: 0, released: 0 });
    expect((alerts[0] as { ageMinutes: number }).ageMinutes).toBe(0);
  });

  it("sends nothing for a job an hour old or more", async () => {
    const { store, alerts } = memoryStore([candidate({}, 60)]);
    expect(await alertPass(store, DAY, config)).toEqual({ sent: 0, held: 0, released: 0 });
    expect(alerts).toEqual([]);
  });

  it("holds a fresh job found in quiet hours and sends it once after they end", async () => {
    const { store, alerts, holds } = memoryStore([candidate({}, 12, NIGHT)]);
    expect(await alertPass(store, NIGHT, config)).toEqual({ sent: 0, held: 1, released: 0 });
    expect(await alertPass(store, new Date("2026-11-26T03:00:00Z"), config)).toEqual({
      sent: 0,
      held: 0,
      released: 0,
    });
    expect(await alertPass(store, MORNING, config)).toEqual({ sent: 0, held: 0, released: 1 });
    expect(await alertPass(store, MORNING, config)).toEqual({ sent: 0, held: 0, released: 0 });
    expect([holds.length, alerts]).toEqual([
      1,
      [{ jobId: "job-1", score: 88, ageMinutes: 467, tier: null, now: MORNING, wasHeld: true }],
    ]);
  });

  it("lets a tier-1 job break quiet hours when allowed", async () => {
    const tier1 = candidate(
      { sourceUrls: ["https://boards.greenhouse.io/Globex/jobs/9"] },
      5,
      NIGHT,
    );
    const { store } = memoryStore([tier1]);
    expect(await alertPass(store, NIGHT, config)).toEqual({ sent: 1, held: 0, released: 0 });
  });

  it("holds a tier-1 job in quiet hours when tier-1 alerts may not break them", async () => {
    const tier1 = candidate(
      { sourceUrls: ["https://boards.greenhouse.io/globex/jobs/9"] },
      5,
      NIGHT,
    );
    const { store } = memoryStore([tier1]);
    const strict = { ...config, tier1InQuietHours: false };
    expect(await alertPass(store, NIGHT, strict)).toEqual({ sent: 0, held: 1, released: 0 });
  });

  it("holds a tier-2 job in quiet hours", async () => {
    const tier2 = candidate(
      { sourceUrls: ["https://jobs.lever.co/initech/0b5e6a3c-1111-4222-8333-444455556666"] },
      5,
      NIGHT,
    );
    const { store } = memoryStore([tier2]);
    expect(await alertPass(store, NIGHT, config)).toEqual({ sent: 0, held: 1, released: 0 });
  });

  it("reports its counts on a sources.fresh_alerts span", async () => {
    const { store } = memoryStore([candidate()]);
    await alertPass(store, DAY, config);
    const [span] = exporter.getFinishedSpans();
    expect([span?.name, span?.attributes]).toEqual([
      "sources.fresh_alerts",
      { "alerts.sent": 1, "alerts.held": 0, "alerts.released": 0 },
    ]);
  });

  it("reads Paul's stored settings on each pass and sends at night once he turns quiet hours off (NS-199)", async () => {
    const { store } = memoryStore([candidate({}, 5, NIGHT)]);
    let stored: StoredAlertSettings | null = null;
    store.settings = async () => stored;
    // The env default holds it for quiet hours...
    expect(await alertPass(store, NIGHT, config)).toEqual({ sent: 0, held: 1, released: 0 });
    // ...and the next pass, with no restart, releases it under Paul's stored setting.
    stored = { quiet: "off", timeZone: null, tier1InQuietHours: null };
    expect(await alertPass(store, NIGHT, config)).toEqual({ sent: 0, held: 0, released: 1 });
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.attributes["alerts.settings_source"])).toEqual(["default", "mixed"]);
  });

  it("marks the span as an error, by name only, when the settings read fails (NS-199)", async () => {
    const { store } = memoryStore([candidate()]);
    store.settings = async () => {
      throw new TypeError("row (secret) failed");
    };
    await expect(alertPass(store, DAY, config)).rejects.toThrow(TypeError);
    const [span] = exporter.getFinishedSpans();
    expect(span?.status).toEqual({ code: 2, message: "TypeError" });
  });

  it("marks the span as an error, by name only, when the store fails", async () => {
    const { store } = memoryStore([candidate()]);
    store.alert = async () => {
      throw new TypeError("row (secret) failed");
    };
    await expect(alertPass(store, DAY, config)).rejects.toThrow(TypeError);
    const [span] = exporter.getFinishedSpans();
    expect(span?.status).toEqual({ code: 2, message: "TypeError" });
  });
});

describe("freshSince", () => {
  it("is exactly the freshness window before now, so the alert read keeps every job decideAlert finds fresh", () => {
    const now = new Date("2026-11-25T12:00:00Z");
    expect(freshSince(now)).toEqual(new Date("2026-11-25T11:00:00Z"));
    expect(FRESH_MINUTES).toBe(60);
  });
});

describe("decideAlert", () => {
  it("never alerts a job twice", () => {
    expect(decideAlert({ alerted: true, held: true }, 1, 1, false, config)).toEqual({
      kind: "none",
      reason: "already_alerted",
    });
  });
});

describe("inQuietHours", () => {
  it("wraps midnight: its start is inside and its end is not", () => {
    const at = (iso: string) => inQuietHours(new Date(iso), config);
    expect([
      at("2026-11-25T21:59:00Z"),
      at("2026-11-25T22:00:00Z"),
      at("2026-11-26T03:00:00Z"),
      at("2026-11-26T06:59:00Z"),
      at("2026-11-26T07:00:00Z"),
    ]).toEqual([false, true, true, true, false]);
  });

  it("reads the hour in the configured time zone", () => {
    // 03:30 UTC is 22:30 the evening before in New York (EST, UTC-5).
    const ny = { ...config, timeZone: "America/New_York" };
    expect([
      inQuietHours(new Date("2026-11-26T03:30:00Z"), ny),
      inQuietHours(new Date("2026-11-25T23:30:00Z"), ny),
    ]).toEqual([true, false]);
  });

  it("handles a range that doesn't wrap midnight", () => {
    const lunch = { ...config, quiet: { start: 12 * 60, end: 13 * 60 } };
    expect([
      inQuietHours(new Date("2026-11-25T12:30:00Z"), lunch),
      inQuietHours(new Date("2026-11-25T13:00:00Z"), lunch),
    ]).toEqual([true, false]);
  });

  it("is never quiet when quiet hours are off", () => {
    expect(inQuietHours(NIGHT, { ...config, quiet: null })).toBe(false);
  });
});

describe("jobTier", () => {
  it("takes the best tier among the watched boards a job's sources come from", () => {
    expect(
      jobTier(
        [
          "https://jobs.lever.co/initech/0b5e6a3c-1111-4222-8333-444455556666",
          "https://boards.greenhouse.io/globex/jobs/1",
        ],
        watches,
      ),
    ).toBe(1);
  });

  it("gives no tier to a job from no watched board, or a link it can't read", () => {
    expect([
      jobTier(["https://boards.greenhouse.io/acme/jobs/1"], watches),
      jobTier(["https://jobs.example.com/1"], watches),
    ]).toEqual([null, null]);
  });
});

describe("loadAlertConfig", () => {
  it("defaults to 22:00-07:00 in this machine's zone with tier-1 alerts allowed", () => {
    expect(loadAlertConfig({}, "Europe/London")).toEqual({
      ok: true,
      value: {
        quiet: { start: 1320, end: 420 },
        timeZone: "Europe/London",
        tier1InQuietHours: true,
      },
    });
  });

  it("reads each setting, and off turns quiet hours off", () => {
    expect(
      loadAlertConfig(
        {
          ALERT_QUIET_HOURS: "off",
          ALERT_TIME_ZONE: "America/Chicago",
          ALERT_TIER1_IN_QUIET_HOURS: "false",
        },
        "UTC",
      ),
    ).toEqual({
      ok: true,
      value: { quiet: null, timeZone: "America/Chicago", tier1InQuietHours: false },
    });
  });

  it("refuses a bad value by the setting's name", () => {
    expect([
      loadAlertConfig({ ALERT_QUIET_HOURS: "10pm-7am" }, "UTC"),
      loadAlertConfig({ ALERT_QUIET_HOURS: "07:00-07:00" }, "UTC"),
      loadAlertConfig({ ALERT_TIME_ZONE: "Mars/Olympus" }, "UTC"),
      loadAlertConfig({ ALERT_TIER1_IN_QUIET_HOURS: "yes" }, "UTC"),
    ]).toEqual([
      { ok: false, setting: "ALERT_QUIET_HOURS" },
      { ok: false, setting: "ALERT_QUIET_HOURS" },
      { ok: false, setting: "ALERT_TIME_ZONE" },
      { ok: false, setting: "ALERT_TIER1_IN_QUIET_HOURS" },
    ]);
  });
});

describe("scoreThenAlert", () => {
  it("returns the scoring result when the alert pass fails, and reports the failure by name", async () => {
    const reported: string[] = [];
    const result = await scoreThenAlert(
      async () => "scored",
      async () => {
        throw new TypeError("row (secret) failed");
      },
      (name) => reported.push(name),
    );
    expect([result, reported]).toEqual(["scored", ["TypeError"]]);
  });

  it("skips the alert pass when scoring fails", async () => {
    let alerted = 0;
    await expect(
      scoreThenAlert(
        async () => {
          throw new RangeError("scoring failed");
        },
        async () => {
          alerted++;
        },
        () => {},
      ),
    ).rejects.toThrow(RangeError);
    expect(alerted).toBe(0);
  });
});
