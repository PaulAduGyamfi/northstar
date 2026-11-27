import { CandidateId, packageSha256 } from "@northstar/domain";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adapterFor } from "./adapters/index.js";
import type { PageState } from "./driver.js";
import {
  CLOSE_TIMEOUT_MS,
  NotApprovedError,
  SUBMIT_TIMEOUT_MS,
  submitApplication,
} from "./submit.js";
import { type FakeWorld, fakeWorld } from "./test/fakes.js";
import { APPLY_URLS, CONFIRMATIONS, FORMS, makePackage } from "./test/fixtures.js";

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

async function run(world: FakeWorld, decisionId = world.approve(pkg), p: unknown = pkg) {
  return submitApplication(world.ports, { candidateId, decisionId, package: p });
}

describe("approval", () => {
  it("throws NotApproved for an id the Gate doesn't know, and claims nothing", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    await expect(run(world, "44444444-4444-4444-8444-444444444444")).rejects.toEqual(
      new NotApprovedError("NotFound"),
    );
    expect([world.submissions.length, world.driverCalls.open]).toEqual([0, 0]);
  });

  it.each(["Rejected", "Undone", "UndoWindowOpen"] as const)(
    "throws NotApproved when the Gate says %s",
    async (refusal) => {
      const world = fakeWorld({ open: form, submit: confirmed });
      await expect(run(world, world.approve(pkg, refusal))).rejects.toEqual(
        new NotApprovedError(refusal),
      );
      expect([world.submissions.length, world.driverCalls.open]).toEqual([0, 0]);
    },
  );

  it("throws NotApproved when the package changed after approval", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    const decisionId = world.approve(pkg);
    const edited = makePackage("greenhouse", {
      fields: { ...pkg.fields, question_1001: "No" },
    });
    await expect(run(world, decisionId, edited)).rejects.toEqual(
      new NotApprovedError("ContentChanged"),
    );
    expect([world.submissions.length, world.driverCalls.open]).toEqual([0, 0]);
  });

  it("throws NotApproved for an approval of another package", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    const other = makePackage("greenhouse", { packageId: "55555555-5555-4555-8555-555555555555" });
    await expect(run(world, world.approve(other))).rejects.toEqual(
      new NotApprovedError("SubjectMismatch"),
    );
    expect([world.submissions.length, world.driverCalls.open]).toEqual([0, 0]);
  });
});

describe("withdrawing an approval whose package changed (NS-211)", () => {
  const edited = makePackage("greenhouse", { fields: { ...pkg.fields, question_1001: "No" } });
  const withdrawSpan = () =>
    exporter.getFinishedSpans().find((s) => s.name === "apply.submit")?.attributes[
      "northstar.apply.withdraw"
    ];

  it("withdraws the approval with the edited package's hash, and still throws ContentChanged", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    const decisionId = world.approve(pkg);
    await expect(run(world, decisionId, edited)).rejects.toEqual(
      new NotApprovedError("ContentChanged"),
    );
    expect([
      world.withdrawals.map((w) => w.newContentSha256),
      world.submissions.length,
      world.driverCalls.open,
      withdrawSpan(),
    ]).toEqual([[packageSha256(edited)], 0, 0, "withdrawn"]);
  });

  it("refuses the old decision id afterwards, even for the original package", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    const decisionId = world.approve(pkg);
    await expect(run(world, decisionId, edited)).rejects.toThrow(NotApprovedError);
    await expect(run(world, decisionId, pkg)).rejects.toEqual(new NotApprovedError("Withdrawn"));
    expect(world.withdrawals.length).toBe(1);
  });

  it("withdraws nothing when the resume bytes changed under an unchanged package", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    const other = makePackage("greenhouse", {
      resume: { fileName: "resume.pdf", sha256: "f".repeat(64) },
    });
    const result = await run(world, world.approve(other), other);
    expect([result, world.withdrawals]).toEqual([
      { ok: false, error: { kind: "FileChanged", file: "resume" } },
      [],
    ]);
  });

  it.each(["Rejected", "Undone", "UndoWindowOpen"] as const)(
    "withdraws nothing when the Gate says %s",
    async (refusal) => {
      const world = fakeWorld({ open: form, submit: confirmed });
      await expect(run(world, world.approve(pkg, refusal))).rejects.toThrow(NotApprovedError);
      expect(world.withdrawals).toEqual([]);
    },
  );

  it.each(["NotApproved", "UndoWindowOpen", "AlreadyClosed"] as const)(
    "records a %s withdrawal refusal on the span and still throws ContentChanged",
    async (withdrawRefusal) => {
      const world = fakeWorld({ open: form, submit: confirmed, withdrawRefusal });
      await expect(run(world, world.approve(pkg), edited)).rejects.toEqual(
        new NotApprovedError("ContentChanged"),
      );
      expect([world.withdrawals.length, withdrawSpan()]).toEqual([1, withdrawRefusal]);
    },
  );
});

describe("refusals before anything is claimed", () => {
  it("refuses an apply URL off the ATS's own hosts", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    const elsewhere = makePackage("greenhouse", { applyUrl: "https://apply.example.com/4001" });
    expect(await run(world, world.approve(elsewhere), elsewhere)).toEqual({
      ok: false,
      error: { kind: "HostNotAllowed" },
    });
  });

  it("refuses a posting id that isn't the one in the apply URL", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    const other = makePackage("greenhouse", { postingId: "4002" });
    expect(await run(world, world.approve(other), other)).toEqual({
      ok: false,
      error: { kind: "PostingMismatch" },
    });
  });

  it("refuses a SmartRecruiters posting id that isn't the one in the apply URL (NS-173)", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    const other = makePackage("smartrecruiters", { postingId: "7440001234568" });
    expect(await run(world, world.approve(other), other)).toEqual({
      ok: false,
      error: { kind: "PostingMismatch" },
    });
  });

  it("refuses a SmartRecruiters apply URL on its careers host until it is rewritten", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    const careers = makePackage("smartrecruiters", {
      applyUrl: "https://careers.smartrecruiters.com/ExampleCorp/7440001234567-backend-engineer",
    });
    expect(await run(world, world.approve(careers), careers)).toEqual({
      ok: false,
      error: { kind: "HostNotAllowed" },
    });
  });

  it("refuses when the resume bytes no longer match the approved hash", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    const other = makePackage("greenhouse", {
      resume: { fileName: "resume.pdf", sha256: "f".repeat(64) },
    });
    expect(await run(world, world.approve(other), other)).toEqual({
      ok: false,
      error: { kind: "FileChanged", file: "resume" },
    });
  });
});

describe("submitting", () => {
  it("says an application an auto-approve policy cleared went out as auto (INB-007)", async () => {
    const auto = fakeWorld({ open: form, submit: confirmed, decidedBy: "policy" });
    const paul = fakeWorld({ open: form, submit: confirmed });
    await run(auto);
    await run(paul);
    expect([auto.submittedVia, paul.submittedVia]).toEqual([["auto"], ["approved"]]);
  });

  it("submits, stores proof and moves the application to submitted", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    const result = await run(world);
    expect([
      result.ok && result.value.outcome,
      world.status(),
      world.proofs[0]?.fieldValues,
      [...(world.proofs[0]?.screenshotPng ?? [])],
      world.driverCalls.close,
    ]).toEqual([
      "submitted",
      "submitted",
      {
        first_name: "Ada",
        last_name: "Example",
        email: "ada@example.com",
        question_1001: "Yes",
        question_1002: "Synthetic answer for a test.",
        resume: "resume.pdf",
      },
      [137, 80, 78, 71],
      1,
    ]);
  });

  it("opens the browser bound to the adapter's own hosts (NS-225)", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    const asked: (readonly string[])[] = [];
    const openDriver = world.ports.openDriver;
    world.ports.openDriver = (hosts) => {
      asked.push(hosts);
      return openDriver(hosts);
    };
    await run(world);
    expect(asked).toEqual([adapterFor("greenhouse").hosts]);
  });

  it("reports each browser step to the onStep hook, in order (NS-225 slice 4)", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    const steps: string[] = [];
    world.ports.onStep = (step) => steps.push(step);
    await run(world);
    expect(steps).toEqual(["open", "submit", "close"]);
  });

  it("reports open and close only when the form shows a challenge", async () => {
    const world = fakeWorld({ open: async () => ({ kind: "challenge", challenge: "captcha" }) });
    const steps: string[] = [];
    world.ports.onStep = (step) => steps.push(step);
    await run(world);
    expect(steps).toEqual(["open", "close"]);
  });

  it("submits the same way when the onStep hook throws", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    world.ports.onStep = () => {
      throw new Error("heartbeat failed");
    };
    const result = await run(world);
    expect([result.ok && result.value.outcome, world.status()]).toEqual(["submitted", "submitted"]);
  });

  it("submitting twice sends one application and returns the first proof", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    const decisionId = world.approve(pkg);
    const first = await run(world, decisionId);
    const second = await run(world, decisionId);
    expect([
      world.driverCalls.submit,
      second.ok && second.value.replayed,
      second.ok && second.value.outcome === "submitted" && second.value.proofId,
    ]).toEqual([1, true, first.ok && first.value.outcome === "submitted" && first.value.proofId]);
  });

  it("never retries a claim a crashed run left in progress", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    const decisionId = world.approve(pkg);
    // A run that crashed after its claim and its move to submitting.
    await world.ports.claimSubmission({
      candidateId,
      applicationId: pkg.applicationId,
      decisionId,
      ats: "greenhouse",
      postingId: pkg.postingId,
    });
    await world.ports.transitionApplication({
      candidateId,
      applicationId: pkg.applicationId as never,
      from: "awaiting_approval",
      to: "submitting",
      actor: "agent:apply",
      reason: "",
      inputsSummary: "",
      links: [],
      idempotencyKey: "crashed-run",
    });
    const result = await run(world, decisionId);
    expect([
      result.ok && result.value.outcome === "needs_human" && result.value.reason,
      world.driverCalls.open,
      world.status(),
    ]).toEqual(["outcome_unknown", 0, "needs_human"]);
  });

  it("leaves a claim another run may still be driving alone", async () => {
    const world = fakeWorld({ open: form, submit: confirmed, claimStale: false });
    const decisionId = world.approve(pkg);
    await world.ports.claimSubmission({
      candidateId,
      applicationId: pkg.applicationId,
      decisionId,
      ats: "greenhouse",
      postingId: pkg.postingId,
    });
    const result = await run(world, decisionId);
    expect([result, world.submissions[0]?.status, world.driverCalls.open]).toEqual([
      { ok: false, error: { kind: "InProgress" } },
      "in_progress",
      0,
    ]);
  });

  it("hands a claim left before the move to submitting to Paul", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    const decisionId = world.approve(pkg);
    await world.ports.claimSubmission({
      candidateId,
      applicationId: pkg.applicationId,
      decisionId,
      ats: "greenhouse",
      postingId: pkg.postingId,
    });
    const result = await run(world, decisionId);
    expect([
      result.ok && result.value.outcome === "needs_human" && result.value.reason,
      world.driverCalls.open,
      world.status(),
    ]).toEqual(["outcome_unknown", 0, "needs_human"]);
  });

  it("refuses a second application to the same requisition", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    await run(world);
    const repost = makePackage("greenhouse", {
      packageId: "66666666-6666-4666-8666-666666666666",
      applicationId: "77777777-7777-4777-8777-777777777777",
    });
    expect(await run(world, world.approve(repost), repost)).toEqual({
      ok: false,
      error: { kind: "DuplicateRequisition" },
    });
  });

  it("hands off without opening the form when the application isn't awaiting approval", async () => {
    const world = fakeWorld({ open: form, submit: confirmed, initialStatus: "withdrawn" });
    const result = await run(world);
    expect([
      result.ok && result.value.outcome === "needs_human" && result.value.reason,
      world.driverCalls.open,
      world.status(),
    ]).toEqual(["status_conflict", 0, "withdrawn"]);
  });
});

describe("needs_human", () => {
  const cases: [string, Partial<Parameters<typeof fakeWorld>[0]>, string][] = [
    [
      "a CAPTCHA on the form",
      { open: async () => ({ kind: "challenge", challenge: "captcha" }) },
      "captcha",
    ],
    [
      "a login wall after submit",
      { submit: async () => ({ kind: "challenge", challenge: "login" }) },
      "login",
    ],
    [
      "a required field the package can't fill",
      {
        open: async () => ({
          kind: "form",
          url: APPLY_URLS.greenhouse,
          fields: [...FORMS.greenhouse, { name: "question_7", type: "text", required: true }],
        }),
      },
      "unmapped_required",
    ],
    [
      "a form that lost a field",
      {
        open: async () => ({
          kind: "form",
          url: APPLY_URLS.greenhouse,
          fields: FORMS.greenhouse.filter((f) => f.name !== "question_1002"),
        }),
      },
      "form_changed",
    ],
    [
      "a page after submit that isn't a confirmation",
      {
        submit: async () => ({
          kind: "page",
          url: pkg.applyUrl,
          html: "<p>Please fix the errors</p>",
          screenshotPng: PNG,
        }),
      },
      "no_confirmation",
    ],
    [
      "a form reached by a redirect off the ATS's hosts",
      {
        open: async () => ({
          kind: "form",
          url: "https://apply.example.com/4001",
          fields: FORMS.greenhouse,
        }),
      },
      "form_changed",
    ],
    [
      "a confirmation page on another host",
      {
        submit: async () => ({
          kind: "page",
          url: "https://apply.example.com/jobs/4001/confirmation",
          html: CONFIRMATIONS.greenhouse.html,
          screenshotPng: PNG,
        }),
      },
      "no_confirmation",
    ],
    [
      "a browser crash during submit",
      {
        submit: async () => {
          throw new Error("Target closed");
        },
      },
      "driver_error",
    ],
    [
      "a timeout opening the page",
      {
        open: async () => {
          throw new Error("Timeout 15000ms exceeded");
        },
      },
      "driver_error",
    ],
  ];

  it.each(cases)("%s ends needs_human with its reason", async (_name, script, reason) => {
    const world = fakeWorld({ open: form, submit: confirmed, ...script });
    const result = await run(world);
    expect([
      result.ok && result.value.outcome === "needs_human" && result.value.reason,
      world.status(),
      world.submissions[0]?.status,
      world.proofs.length,
      world.driverCalls.close,
    ]).toEqual([reason, "needs_human", "needs_human", 0, 1]);
  });

  it("ends a submit that never returns as driver_error after its time limit", async () => {
    vi.useFakeTimers();
    try {
      const world = fakeWorld({ open: form, submit: () => new Promise<PageState>(() => {}) });
      const pending = run(world);
      await vi.advanceTimersByTimeAsync(SUBMIT_TIMEOUT_MS);
      const result = await pending;
      expect([
        result.ok && result.value.outcome === "needs_human" && result.value.reason,
        world.status(),
        world.driverCalls.close,
      ]).toEqual(["driver_error", "needs_human", 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still records the submission when the browser never finishes closing", async () => {
    vi.useFakeTimers();
    try {
      const world = fakeWorld({
        open: form,
        submit: confirmed,
        close: () => new Promise(() => {}),
      });
      const pending = run(world);
      await vi.advanceTimersByTimeAsync(CLOSE_TIMEOUT_MS);
      const result = await pending;
      expect([result.ok && result.value.outcome, world.status()]).toEqual([
        "submitted",
        "submitted",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("types nothing when the form needs a field the package can't fill", async () => {
    const world = fakeWorld({
      open: async () => ({
        kind: "form",
        url: APPLY_URLS.greenhouse,
        fields: [...FORMS.greenhouse, { name: "question_7", type: "text", required: true }],
      }),
      submit: confirmed,
    });
    await run(world);
    expect(world.driverCalls.submit).toBe(0);
  });
});

describe("observability", () => {
  it("records the ATS and the outcome on the apply.submit span, and nothing else", async () => {
    const world = fakeWorld({ open: form, submit: confirmed });
    await run(world);
    const span = exporter.getFinishedSpans().find((s) => s.name === "apply.submit");
    expect(span?.attributes).toEqual({
      "northstar.apply.ats": "greenhouse",
      "northstar.apply.outcome": "submitted",
    });
  });
});
