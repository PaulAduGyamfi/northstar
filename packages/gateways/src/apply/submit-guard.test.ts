import { CandidateId } from "@northstar/domain";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageState } from "./driver.js";
import { OPEN_TIMEOUT_MS, submitApplication } from "./submit.js";
import { type FakeWorld, fakeWorld } from "./test/fakes.js";
import { APPLY_URLS, CONFIRMATIONS, FORMS, makePackage } from "./test/fixtures.js";

// Kill switches and the ATS breaker in the Apply Gateway (NS-206, RES-002, RES-008). Fakes only:
// the switches' and breakers' own behavior is tested on PGlite in packages/db.
const candidateId = CandidateId.parse("33333333-3333-4333-8333-333333333333");
const PNG = new Uint8Array([137, 80, 78, 71]);
const form = async (): Promise<PageState> => ({
  kind: "form",
  url: APPLY_URLS.greenhouse,
  fields: FORMS.greenhouse,
});
const confirmed = async (): Promise<PageState> => ({
  kind: "page",
  ...CONFIRMATIONS.greenhouse,
  screenshotPng: PNG,
});
const RETRY_AT = new Date("2026-11-26T02:00:00Z");

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
afterAll(() => {
  trace.disable();
});
beforeEach(() => {
  exporter.reset();
});

const pkg = makePackage("greenhouse");
const run = (world: FakeWorld) =>
  submitApplication(world.ports, { candidateId, decisionId: world.approve(pkg), package: pkg });

// Nothing happened: no claim, no status move, no browser, no breaker report.
const untouched = (world: FakeWorld) => [
  world.submissions.length,
  world.status(),
  world.driverCalls.open,
  world.reports.length,
];

describe("held back before anything is claimed", () => {
  it("holds a submission back while auto_apply is switched off", async () => {
    const world = fakeWorld({ open: form, submit: confirmed, switchesOff: ["auto_apply"] });
    expect(await run(world)).toEqual({
      ok: false,
      error: { kind: "HeldBack", by: "kill_switch", what: "auto_apply", retryAt: null },
    });
    expect(untouched(world)).toEqual([0, "awaiting_approval", 0, 0]);
  });

  it("holds a submission back while its ATS's adapter is switched off", async () => {
    const world = fakeWorld({
      open: form,
      submit: confirmed,
      switchesOff: ["adapter:greenhouse"],
    });
    expect(await run(world)).toEqual({
      ok: false,
      error: { kind: "HeldBack", by: "kill_switch", what: "adapter:greenhouse", retryAt: null },
    });
    expect(untouched(world)).toEqual([0, "awaiting_approval", 0, 0]);
  });

  it("holds a submission back until the ATS's breaker allows the next try", async () => {
    const world = fakeWorld({
      open: form,
      submit: confirmed,
      breaker: async () => ({ allowed: false, retryAt: RETRY_AT, lastError: "Timeout" }),
    });
    expect(await run(world)).toEqual({
      ok: false,
      error: { kind: "HeldBack", by: "breaker", what: "ats:greenhouse", retryAt: RETRY_AT },
    });
    expect(untouched(world)).toEqual([0, "awaiting_approval", 0, 0]);
  });

  it("holds a submission back when the checks themselves fail", async () => {
    const world = fakeWorld({
      open: form,
      submit: confirmed,
      breaker: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(await run(world)).toEqual({
      ok: false,
      error: { kind: "HeldBack", by: "guard_error", what: "ats:greenhouse", retryAt: null },
    });
    expect(untouched(world)).toEqual([0, "awaiting_approval", 0, 0]);
    const span = exporter.getFinishedSpans().find((s) => s.name === "apply.submit");
    expect([
      span?.attributes["northstar.apply.outcome"],
      span?.attributes["northstar.apply.held_by"],
      span?.attributes["northstar.apply.guard_error"],
    ]).toEqual(["HeldBack", "guard_error", "Error"]);
  });

  it("asks auto_apply, then the adapter's switch, then the ATS's breaker", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    await run(world);
    expect(world.checks).toEqual(["auto_apply", "adapter:greenhouse", "ats:greenhouse"]);
  });
});

describe("what the ATS's breaker is told", () => {
  it("reports a confirmed submission as the ATS working", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    await run(world);
    expect(world.reports).toEqual([
      { dependency: "ats:greenhouse", outcome: { ok: true }, probeToken: null },
    ]);
  });

  it("passes the probe's token back with its report", async () => {
    const token = "2026-11-26T01:52:00.000Z";
    const world = fakeWorld({
      open: form,
      submit: confirmed,
      breaker: async () => ({ allowed: true, probe: true, probeToken: token }),
    });
    await run(world);
    expect(world.reports).toEqual([
      { dependency: "ats:greenhouse", outcome: { ok: true }, probeToken: token },
    ]);
  });

  it("reports a challenge page as the ATS answering", async () => {
    const world = fakeWorld({
      open: async () => ({ kind: "challenge", challenge: "captcha" }),
      submit: confirmed,
    });
    const result = await run(world);
    expect([result.ok && result.value.outcome, world.reports]).toEqual([
      "needs_human",
      [{ dependency: "ats:greenhouse", outcome: { ok: true }, probeToken: null }],
    ]);
  });

  it("reports a page that never opens in time as the ATS failing", async () => {
    vi.useFakeTimers();
    try {
      const world = fakeWorld({ open: () => new Promise<PageState>(() => {}), submit: confirmed });
      const pending = run(world);
      await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);
      const result = await pending;
      expect([result.ok && result.value.outcome, world.reports]).toEqual([
        "needs_human",
        [
          {
            dependency: "ats:greenhouse",
            outcome: { ok: false, error: "Timeout" },
            probeToken: null,
          },
        ],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts the browser's own timeout error against the ATS too", async () => {
    const timeout = Object.assign(new Error("Timeout 30000ms exceeded"), { name: "TimeoutError" });
    const world = fakeWorld({
      open: async () => {
        throw timeout;
      },
    });
    await run(world);
    expect(world.reports).toEqual([
      { dependency: "ats:greenhouse", outcome: { ok: false, error: "Timeout" }, probeToken: null },
    ]);
  });

  it("doesn't blame the ATS for a browser that crashed", async () => {
    const world = fakeWorld({
      open: form,
      submit: async () => {
        throw new Error("Target closed");
      },
    });
    const result = await run(world);
    expect([result.ok && result.value.outcome, world.reports]).toEqual(["needs_human", []]);
  });

  it("keeps the submission's outcome when the report itself fails", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    world.ports.recordCallOutcome = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const result = await run(world);
    expect([result.ok && result.value.outcome, world.status()]).toEqual(["submitted", "submitted"]);
    const span = exporter.getFinishedSpans().find((s) => s.name === "apply.submit");
    expect(span?.attributes["northstar.apply.breaker_report_failed"]).toBe(true);
  });
});
