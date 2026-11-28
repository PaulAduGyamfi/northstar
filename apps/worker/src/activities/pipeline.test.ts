import type { JobFormQuestion, PipelineState } from "@northstar/db";
import { err, ok } from "@northstar/domain";
import type { PrepareResult } from "@northstar/pipeline";
import type { GreenhouseFormRead, PollGuard } from "@northstar/sources";
import { ApplicationFailure } from "@temporalio/common";
import { describe, expect, it } from "vitest";
import { createPipelineActivities, type PipelinePorts } from "./pipeline.js";

// The job pipeline's activities (NS-280 slice 2) on fakes: no database, network or Temporal.

const CANDIDATE = "00000000-0000-4000-8000-0000000000c1";
const APP = "00000000-0000-4000-8000-0000000000a1";
const JOB = "00000000-0000-4000-8000-0000000000b1";
const RUN = "00000000-0000-4000-8000-0000000000e1";
const SHA = "d".repeat(64);
const args = { candidateId: CANDIDATE, applicationId: APP };

const QUESTION: JobFormQuestion = {
  fieldName: "first_name",
  label: "First Name",
  required: true,
  kind: "text",
  choices: null,
  group: 0,
};

type Calls = {
  tailor: number;
  read: number;
  prepare: number;
  reports: unknown[];
  letters: unknown[];
};

function fakes(options: {
  state?: PipelineState | null;
  target?: { board: string; postingId: string } | null;
  on?: boolean;
  allowed?: boolean;
  read?: () => Promise<GreenhouseFormRead>;
  prepared?: PrepareResult;
  start?: PipelinePorts["start"];
}) {
  const calls: Calls = { tailor: 0, read: 0, prepare: 0, reports: [], letters: [] };
  const guard: PollGuard = {
    isOn: async () => options.on ?? true,
    acquire: async () =>
      options.allowed === false
        ? { allowed: false, retryAt: new Date(0), lastError: null }
        : { allowed: true, probe: false },
    report: async (dependency, outcome, probeToken) => {
      calls.reports.push([dependency, outcome, probeToken]);
    },
  };
  const ports: PipelinePorts = {
    state: async () =>
      options.state === undefined
        ? { status: "queued", jobId: JOB, packageSha256: null }
        : options.state,
    tailor: async () => {
      calls.tailor++;
      return { kind: "tailored", saved: true };
    },
    formTarget: async () =>
      options.target === undefined ? { board: "example", postingId: "123" } : options.target,
    guard: () => guard,
    readForm: async () => {
      calls.read++;
      return options.read ? options.read() : { kind: "form", questions: [QUESTION] };
    },
    saveForm: async () => ({ status: "stored", questions: 1 }),
    prepare: async () => {
      calls.prepare++;
      return options.prepared ?? { kind: "needs_human", reasons: { no_form: 1 }, recorded: true };
    },
    start: options.start ?? (async () => ok({ workflowId: `submission:${APP}:${SHA}` })),
    recordLetter: async (letter) => {
      calls.letters.push(letter);
      return ok({ status: "recorded", deadLetterId: RUN });
    },
  };
  return { activities: createPipelineActivities(ports), calls, ports };
}

// The error type a rejected activity call carries, or what it resolved to.
async function failureOf(call: Promise<unknown>): Promise<unknown> {
  try {
    return { resolved: await call };
  } catch (error) {
    return error instanceof ApplicationFailure
      ? [error.type, error.nonRetryable]
      : (error as Error).constructor.name;
  }
}

describe("tailorResume (NS-280 slice 2)", () => {
  it("tailors a queued application's job, and skips one past queued without tailoring", async () => {
    const queued = fakes({});
    const later = fakes({ state: { status: "package_ready", jobId: JOB, packageSha256: null } });
    expect([
      await queued.activities.tailorResume(args),
      queued.calls.tailor,
      await later.activities.tailorResume(args),
      later.calls.tailor,
    ]).toEqual([{ kind: "tailored", saved: true }, 1, { kind: "skipped" }, 0]);
  });

  it("refuses ids that aren't uuids for good, without reading anything", async () => {
    const { activities, calls } = fakes({});
    expect([
      await failureOf(activities.tailorResume({ ...args, candidateId: "nope" })),
      calls.tailor,
    ]).toEqual([["InvalidInput", true], 0]);
  });
});

describe("readJobForm (NS-280 slice 2)", () => {
  it("reads and stores the Greenhouse form, reporting Greenhouse answered to its breaker", async () => {
    const { activities, calls } = fakes({});
    expect([await activities.readJobForm(args), calls.reports]).toEqual([
      { kind: "stored" },
      [["source:greenhouse", { ok: true }, null]],
    ]);
  });

  it("says no source for a job with no Greenhouse link, asking neither the guard nor Greenhouse", async () => {
    const { activities, calls } = fakes({ target: null });
    expect([await activities.readJobForm(args), calls.read, calls.reports]).toEqual([
      { kind: "no_source" },
      0,
      [],
    ]);
  });

  it("is held back (retryable) while source:greenhouse is off or its breaker is open, calling nothing", async () => {
    const off = fakes({ on: false });
    const open = fakes({ allowed: false });
    expect([
      await failureOf(off.activities.readJobForm(args)),
      await failureOf(open.activities.readJobForm(args)),
      off.calls.read + open.calls.read,
    ]).toEqual([["HeldBack", false], ["HeldBack", false], 0]);
  });

  it("reports a failed read to the breaker by its class only and fails the attempt", async () => {
    const { activities, calls } = fakes({
      read: async () => {
        throw new TypeError("fetch failed for https://boards-api.greenhouse.io/secret");
      },
    });
    expect([await failureOf(activities.readJobForm(args)), calls.reports]).toEqual([
      ["StepError", false],
      [["source:greenhouse", { ok: false, error: "TypeError" }, null]],
    ]);
  });

  it("reads a 429 or 5xx as Greenhouse failing for now: a breaker failure and a retried attempt, never unreadable", async () => {
    const { activities, calls } = fakes({
      read: async () => ({ kind: "unavailable", status: 503 }),
    });
    expect([await failureOf(activities.readJobForm(args)), calls.reports]).toEqual([
      ["Unavailable", false],
      [["source:greenhouse", { ok: false, error: "Unavailable" }, null]],
    ]);
  });

  it("says unreadable when Greenhouse answers with no form it can read, and skips past queued", async () => {
    const unreadable = fakes({ read: async () => ({ kind: "unreadable" }) });
    const later = fakes({
      state: { status: "awaiting_approval", jobId: JOB, packageSha256: SHA },
    });
    expect([
      await unreadable.activities.readJobForm(args),
      await later.activities.readJobForm(args),
      later.calls.read,
    ]).toEqual([{ kind: "unreadable" }, { kind: "skipped" }, 0]);
  });
});

describe("preparePackage (NS-280 slice 2)", () => {
  it("gives a filed package's hash", async () => {
    const { activities } = fakes({
      prepared: {
        kind: "filed",
        packageId: APP,
        packageSha256: SHA,
        requestId: RUN,
        autoApproved: false,
        decision: null,
        replayed: false,
      },
    });
    expect(await activities.preparePackage(args)).toEqual({ kind: "filed", packageSha256: SHA });
  });

  it("finds the round an earlier run filed without preparing again, and stops when its package is missing", async () => {
    const filed = fakes({ state: { status: "awaiting_approval", jobId: JOB, packageSha256: SHA } });
    const missing = fakes({
      state: { status: "awaiting_approval", jobId: JOB, packageSha256: null },
    });
    expect([
      await filed.activities.preparePackage(args),
      await missing.activities.preparePackage(args),
      filed.calls.prepare + missing.calls.prepare,
    ]).toEqual([
      { kind: "filed", packageSha256: SHA },
      { kind: "stopped", reasonCode: "stored_package_missing" },
      0,
    ]);
  });

  it("passes on Paul being needed, a refusal as a reason code, and an application not found", async () => {
    const needed = fakes({});
    const refused = fakes({ prepared: { kind: "file_refused", reason: "InvalidRequest" } });
    const gone = fakes({ state: null });
    expect([
      await needed.activities.preparePackage(args),
      await refused.activities.preparePackage(args),
      await gone.activities.preparePackage(args),
    ]).toEqual([
      { kind: "needs_human" },
      { kind: "stopped", reasonCode: "file_refused_invalid_request" },
      { kind: "skipped", reason: "not_found" },
    ]);
  });
});

describe("the activities' failures (NS-280 slice 2)", () => {
  it("keep a raw error's message and cause out of Temporal's history: the class name only", async () => {
    class DrizzleQueryError extends Error {}
    const { activities } = fakes({
      read: async () => {
        throw new TypeError("fetch failed for https://boards-api.greenhouse.io/v1/boards/acme", {
          cause: new Error("connect ECONNREFUSED 10.0.0.1"),
        });
      },
    });
    const failing = createPipelineActivities({
      ...fakes({}).ports,
      prepare: async () => {
        throw new DrizzleQueryError("Failed query: insert ...\nparams: someone@example.com");
      },
    });
    const shapes: unknown[] = [];
    for (const call of [activities.readJobForm(args), failing.preparePackage(args)]) {
      try {
        await call;
      } catch (error) {
        const f = error as ApplicationFailure;
        shapes.push([f.type, f.message, f.nonRetryable, f.cause ?? null]);
      }
    }
    expect(shapes).toEqual([
      ["StepError", "TypeError", false, null],
      ["StepError", "DrizzleQueryError", false, null],
    ]);
  });
});

describe("startSubmission (NS-280 slice 2)", () => {
  it("starts the round's submission, and reads a second start as already started", async () => {
    const started = fakes({});
    const exists = fakes({ start: async () => err({ kind: "AlreadyStarted" }) });
    expect([
      await started.activities.startSubmission({ ...args, packageSha256: SHA }),
      await exists.activities.startSubmission({ ...args, packageSha256: SHA }),
    ]).toEqual([{ kind: "started" }, { kind: "exists" }]);
  });

  it("refuses a malformed hash for good", async () => {
    const { activities } = fakes({});
    expect(await failureOf(activities.startSubmission({ ...args, packageSha256: "x" }))).toEqual([
      "InvalidInput",
      true,
    ]);
  });
});

describe("recordPipelineEnding (NS-280 slice 2)", () => {
  it("records one letter keyed by the application and the run", async () => {
    const { activities, calls } = fakes({});
    const result = await activities.recordPipelineEnding({
      ...args,
      runId: RUN,
      reasonCode: "form_failed",
      attempts: 10,
    });
    expect([result, calls.letters]).toEqual([
      { status: "recorded" },
      [
        {
          candidateId: CANDIDATE,
          applicationId: APP,
          reasonCode: "form_failed",
          attempts: 10,
          idempotencyKey: `application:${APP}:pipeline:${RUN}`,
        },
      ],
    ]);
  });
});
