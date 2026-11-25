import type { FitScoreInput, Preferences } from "@northstar/db";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ScoreStore, scorePending } from "./run.js";
import { JOB, PREFS, PROFILE } from "./test/sample.js";

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
beforeEach(() => exporter.reset());

const V1: Preferences = { ...PREFS, id: "p1", version: 1 };

// An in-memory store that keeps saved scores by key, like the unique constraint does.
function store(over: Partial<ScoreStore> = {}) {
  const saved = new Map<string, FitScoreInput>();
  const s: ScoreStore = {
    preferences: async () => V1,
    profile: async () => PROFILE,
    jobs: async () => [JOB, { ...JOB, id: "j2", title: "Data Analyst" }],
    keys: async (pref, src) =>
      new Set(
        [...saved.values()]
          .filter((x) => x.preferenceId === pref && x.profileSourceId === src)
          .map((x) => `${x.jobId}:${x.jobFingerprint}`),
      ),
    save: async (input) => {
      const key = `${input.jobId}:${input.preferenceId}:${input.profileSourceId}:${input.jobFingerprint}`;
      if (saved.has(key)) return "exists";
      saved.set(key, input);
      return "saved";
    },
    ...over,
  };
  return { s, saved };
}

describe("scorePending", () => {
  it("scores every pending job and counts each band", async () => {
    const { s } = store();
    const r = await scorePending(s);
    expect(r.status === "done" && r.counts).toEqual({
      jobs: 2,
      queue: 1,
      suggest: 0,
      skip: 1,
      failed: 0,
    });
  });

  it("scores nothing the second time (safe to repeat)", async () => {
    const { s, saved } = store();
    await scorePending(s);
    const r = await scorePending(s);
    expect([r.status === "done" && r.counts.jobs, saved.size]).toEqual([0, 2]);
  });

  it("re-scores every job under a new preference version", async () => {
    const { s, saved } = store();
    await scorePending(s);
    const v2: Preferences = { ...V1, id: "p2", version: 2, compFloor: 200_000 };
    const r = await scorePending({ ...s, preferences: async () => v2 });
    expect([r.status === "done" && r.counts, saved.size]).toEqual([
      { jobs: 2, queue: 0, suggest: 0, skip: 2, failed: 0 },
      4,
    ]);
  });

  it("re-scores a job whose fields changed", async () => {
    const { s } = store();
    await scorePending(s);
    const r = await scorePending({ ...s, jobs: async () => [{ ...JOB, salaryMax: 190_000 }] });
    expect(r.status === "done" && r.counts.jobs).toBe(1);
  });

  it("stores the preference version, resume import and evidence with each score", async () => {
    const { s, saved } = store({ jobs: async () => [JOB] });
    await scorePending(s);
    const [input] = [...saved.values()];
    expect([
      input?.preferenceId,
      input?.preferenceVersion,
      input?.profileSourceId,
      input?.score,
      ((input?.evidence.matched ?? []) as unknown[]).length,
    ]).toEqual(["p1", 1, PROFILE.sourceId, 80, 3]);
  });

  it("scores nothing without a resume import", async () => {
    const { s, saved } = store({ profile: async () => null });
    expect([await scorePending(s), saved.size]).toEqual([{ status: "no_profile" }, 0]);
  });

  it("scores nothing without preferences", async () => {
    const { s } = store({ preferences: async () => null });
    expect(await scorePending(s)).toEqual({ status: "no_preferences" });
  });

  it("counts a job that won't save as failed and still scores the others", async () => {
    const base = store();
    const { s } = store({
      save: async (input) => {
        if (input.jobId === "j1") throw new Error("database refused");
        return base.s.save(input);
      },
    });
    const r = await scorePending(s);
    expect(r.status === "done" && [r.counts.jobs, r.counts.failed]).toEqual([1, 1]);
  });

  it("puts the failed job's error name, never its message, on the span", async () => {
    const { s } = store({
      save: async () => {
        throw new RangeError("row (secret-title) refused");
      },
    });
    await scorePending(s);
    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes["fit.last_error"]).toBe("RangeError");
    expect(JSON.stringify(span?.attributes)).not.toContain("secret-title");
  });

  it("records a fit.score span with counts only", async () => {
    await scorePending(store().s);
    const [span] = exporter.getFinishedSpans();
    expect([span?.name, span?.attributes]).toEqual([
      "fit.score",
      {
        "fit.outcome": "done",
        "fit.preference_version": 1,
        "fit.jobs": 2,
        "fit.queue": 1,
        "fit.suggest": 0,
        "fit.skip": 1,
        "fit.failed": 0,
      },
    ]);
  });
});

describe("scorePending with a model assist (NS-138)", () => {
  const payments = { requirement: "Payments experience", atomId: "a1", quote: "billing service" };

  it("sends only what the rules left unmatched, and stores an assisted score as rules_model", async () => {
    const asked: string[][] = [];
    const { s, saved } = store({
      jobs: async () => [JOB],
      assist: async (unmatched) => {
        asked.push(unmatched.map((u) => u.requirement));
        return { kind: "assisted", matches: [payments] };
      },
    });
    await scorePending(s);
    const [stored] = [...saved.values()];
    expect([asked, stored?.method]).toEqual([
      [["Experience with Rust", "Terraform", "Payments experience"]],
      "rules_model",
    ]);
  });

  it("stores rules when the assist accepted nothing", async () => {
    const { s, saved } = store({
      jobs: async () => [JOB],
      assist: async () => ({ kind: "assisted", matches: [] }),
    });
    await scorePending(s);
    expect([...saved.values()].map((x) => x.method)).toEqual(["rules"]);
  });

  it("keeps the rules score when the assist fails, and counts it on the span", async () => {
    const { s, saved } = store({
      jobs: async () => [JOB],
      assist: async () => {
        throw new TypeError("transport down");
      },
    });
    const r = await scorePending(s);
    const span = exporter.getFinishedSpans().find((x) => x.name === "fit.score");
    expect([
      r.status,
      [...saved.values()].map((x) => x.method),
      span?.attributes["fit.assist_failed"],
      span?.attributes["fit.assisted"],
    ]).toEqual(["done", ["rules"], 1, 0]);
  });

  it("counts a refused or malformed assist as failed and keeps the rules score", async () => {
    const { s, saved } = store({
      jobs: async () => [JOB],
      assist: async () => ({ kind: "failed" }),
    });
    await scorePending(s);
    const span = exporter.getFinishedSpans().find((x) => x.name === "fit.score");
    expect([
      [...saved.values()].map((x) => x.method),
      span?.attributes["fit.assist_failed"],
    ]).toEqual([["rules"], 1]);
  });

  it("doesn't ask about a job whose rules matched everything", async () => {
    let calls = 0;
    const { s } = store({
      jobs: async () => [{ ...JOB, requirements: ["PostgreSQL at scale"], niceToHaves: [] }],
      assist: async () => {
        calls++;
        return { kind: "assisted", matches: [] };
      },
    });
    await scorePending(s);
    expect(calls).toBe(0);
  });
});
