import {
  applySchema,
  CLAIM_STALE_AFTER_MS,
  claimSubmission,
  type Db,
  decideApprovals,
  listOpenHandoffs,
  requestApproval,
  schema,
  setKillSwitch,
} from "@northstar/db";
import { createTestDb, seedApplication, setGateClock } from "@northstar/db/testing";
import {
  type ApplicationStatus,
  CandidateId,
  packageSha256,
  packageSubject,
  UNDO_WINDOW_MS,
} from "@northstar/domain";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FormDriver, PageState } from "./driver.js";
import { dbPorts } from "./ports.js";
import { NotApprovedError, submitApplication } from "./submit.js";
import { APPLY_URLS, CONFIRMATIONS, FORMS, makePackage, RESUME, sha } from "./test/fixtures.js";

// The gateway on the real write paths (dbPorts on PGlite): the Gate's verifyApproval, the
// submission ledger and transitionApplication, sharing one event log. Only the browser is fake.

const NOW = new Date("2026-11-25T12:00:00Z");
const after = (ms: number) => new Date(NOW.getTime() + ms);
const PNG = new Uint8Array([137, 80, 78, 71]);

// Spans, so a test can read what the gateway recorded (NS-211).
const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
afterAll(() => {
  trace.disable();
});

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let pkg: ReturnType<typeof makePackage>;

beforeEach(async () => {
  exporter.reset();
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "awaiting_approval");
  candidateId = CandidateId.parse(seeded.candidateId);
  pkg = makePackage("greenhouse", { applicationId: seeded.applicationId });
  await setGateClock(db, NOW);
});

afterEach(async () => {
  await close();
});

// Paul approves this package (or `p`); the clock then moves past the undo window unless told not
// to.
async function approve(pastUndoWindow = true, p: typeof pkg = pkg): Promise<string> {
  const requested = await requestApproval(db, {
    candidateId,
    kind: "application_package",
    subject: packageSubject(p),
    contentSha256: packageSha256(p),
    facts: null,
    actor: "agent:apply",
    idempotencyKey: `test:${packageSha256(p)}`,
  });
  if (!requested.ok) throw new Error(requested.error.kind);
  const decided = await decideApprovals(db, {
    candidateId,
    requestIds: [requested.value.requestId],
    decision: "approve",
  });
  const outcome = decided.ok ? decided.value[0]?.result : undefined;
  if (!outcome?.ok) throw new Error("not approved");
  if (pastUndoWindow) await setGateClock(db, after(UNDO_WINDOW_MS));
  return outcome.value.decisionId;
}

function driver(submit: () => Promise<PageState>): () => FormDriver {
  return () => ({
    open: async () => ({ kind: "form", url: APPLY_URLS.greenhouse, fields: FORMS.greenhouse }),
    fillAndSubmit: submit,
    close: async () => {},
  });
}

const confirmed = async (): Promise<PageState> => ({
  kind: "page",
  ...CONFIRMATIONS.greenhouse,
  screenshotPng: PNG,
});

const ports = (submit: () => Promise<PageState> = confirmed) =>
  dbPorts(db, {
    readFile: async (hash) => (hash === sha(RESUME) ? RESUME : null),
    openDriver: driver(submit),
  });

async function applicationStatus(): Promise<ApplicationStatus> {
  const [row] = await db.select({ status: schema.application.status }).from(schema.application);
  return row?.status as ApplicationStatus;
}

async function ledger(): Promise<{ status: string; reason: string | null }[]> {
  return db
    .select({
      status: applySchema.applySubmission.status,
      reason: applySchema.applySubmission.reason,
    })
    .from(applySchema.applySubmission);
}

describe("submitApplication on the real write paths", () => {
  it("submits, stores proof and moves the application to submitted", async () => {
    const decisionId = await approve();
    const result = await submitApplication(ports(), { candidateId, decisionId, package: pkg });
    const proofs = await db.select().from(applySchema.submissionProof);
    expect([
      result.ok && result.value.outcome,
      await applicationStatus(),
      await ledger(),
      proofs.length,
    ]).toEqual(["submitted", "submitted", [{ status: "submitted", reason: null }], 1]);
  });

  it("submitting twice sends one application", async () => {
    const decisionId = await approve();
    let submits = 0;
    const counting = ports(async () => {
      submits++;
      return confirmed();
    });
    await submitApplication(counting, { candidateId, decisionId, package: pkg });
    const second = await submitApplication(counting, { candidateId, decisionId, package: pkg });
    expect([submits, second.ok && second.value.replayed]).toEqual([1, true]);
  });

  it("moves the application to needs_human on a CAPTCHA", async () => {
    const decisionId = await approve();
    const result = await submitApplication(
      ports(async () => ({ kind: "challenge", challenge: "captcha" })),
      { candidateId, decisionId, package: pkg },
    );
    expect([
      result.ok && result.value.outcome === "needs_human" && result.value.reason,
      await applicationStatus(),
      await ledger(),
    ]).toEqual(["captcha", "needs_human", [{ status: "needs_human", reason: "captcha" }]]);
  });

  it("opens a handoff with the package's apply URL when a CAPTCHA stops the form", async () => {
    const decisionId = await approve();
    await submitApplication(
      ports(async () => ({ kind: "challenge", challenge: "captcha" })),
      { candidateId, decisionId, package: pkg },
    );
    const open = await listOpenHandoffs(db, candidateId);
    expect(open.map((h) => [h.applicationId, h.reason, h.applyUrl])).toEqual([
      [pkg.applicationId, "captcha", pkg.applyUrl],
    ]);
  });

  it("hands a stale claim from a dead run to Paul and never opens the form", async () => {
    const decisionId = await approve();
    await claimSubmission(db, {
      candidateId,
      applicationId: pkg.applicationId,
      decisionId,
      ats: "greenhouse",
      postingId: pkg.postingId,
    });
    await setGateClock(db, after(UNDO_WINDOW_MS + CLAIM_STALE_AFTER_MS));
    let submits = 0;
    const result = await submitApplication(
      ports(async () => {
        submits++;
        return confirmed();
      }),
      { candidateId, decisionId, package: pkg },
    );
    expect([
      result.ok && result.value.outcome === "needs_human" && result.value.reason,
      await applicationStatus(),
      await ledger(),
      submits,
    ]).toEqual([
      "outcome_unknown",
      "needs_human",
      [{ status: "needs_human", reason: "outcome_unknown" }],
      0,
    ]);
  });

  it("throws NotApproved inside the undo window and claims nothing", async () => {
    const decisionId = await approve(false);
    await expect(
      submitApplication(ports(), { candidateId, decisionId, package: pkg }),
    ).rejects.toEqual(new NotApprovedError("UndoWindowOpen"));
    expect(await ledger()).toEqual([]);
  });

  it("holds a submission back while Paul has auto_apply switched off, and claims nothing", async () => {
    const decisionId = await approve();
    const off = await setKillSwitch(db, {
      candidateId,
      subsystem: "auto_apply",
      enabled: false,
      actor: "user",
      reason: "pausing applications",
    });
    if (!off.ok) throw new Error(off.error.kind);
    const result = await submitApplication(ports(), { candidateId, decisionId, package: pkg });
    expect([result, await applicationStatus(), await ledger()]).toEqual([
      {
        ok: false,
        error: { kind: "HeldBack", by: "kill_switch", what: "auto_apply", retryAt: null },
      },
      "awaiting_approval",
      [],
    ]);
  });
});

describe("an approval whose package changed, on the real write paths (NS-211)", () => {
  const editedPackage = () =>
    makePackage("greenhouse", {
      applicationId: pkg.applicationId,
      fields: { ...pkg.fields, question_1001: "No" },
    });
  const withdrawnEvents = async () =>
    (await db.select().from(schema.domainEvent)).filter((e) => e.type === "approval.withdrawn");
  const withdrawSpan = () =>
    exporter.getFinishedSpans().find((s) => s.name === "apply.submit")?.attributes[
      "northstar.apply.withdraw"
    ];

  it("withdraws the approval and claims nothing when the package was edited", async () => {
    const decisionId = await approve();
    await expect(
      submitApplication(ports(), { candidateId, decisionId, package: editedPackage() }),
    ).rejects.toEqual(new NotApprovedError("ContentChanged"));
    expect([(await withdrawnEvents()).length, await ledger(), withdrawSpan()]).toEqual([
      1,
      [],
      "withdrawn",
    ]);
  });

  it("refuses the old decision id afterwards, even for the original package", async () => {
    const decisionId = await approve();
    await expect(
      submitApplication(ports(), { candidateId, decisionId, package: editedPackage() }),
    ).rejects.toThrow(NotApprovedError);
    await expect(
      submitApplication(ports(), { candidateId, decisionId, package: pkg }),
    ).rejects.toEqual(new NotApprovedError("Withdrawn"));
  });

  it("submits the edited package under a new approval for the same subject", async () => {
    const oldDecisionId = await approve();
    const edited = editedPackage();
    await expect(
      submitApplication(ports(), { candidateId, decisionId: oldDecisionId, package: edited }),
    ).rejects.toThrow(NotApprovedError);
    const newDecisionId = await approve(false, edited);
    await setGateClock(db, after(2 * UNDO_WINDOW_MS));
    const result = await submitApplication(ports(), {
      candidateId,
      decisionId: newDecisionId,
      package: edited,
    });
    expect([result.ok && result.value.outcome, await ledger()]).toEqual([
      "submitted",
      [{ status: "submitted", reason: null }],
    ]);
  });

  it("records UndoWindowOpen on the span and still throws when the edit comes inside the undo window", async () => {
    const decisionId = await approve(false);
    await expect(
      submitApplication(ports(), { candidateId, decisionId, package: editedPackage() }),
    ).rejects.toEqual(new NotApprovedError("ContentChanged"));
    expect([withdrawSpan(), (await withdrawnEvents()).length, await ledger()]).toEqual([
      "UndoWindowOpen",
      0,
      [],
    ]);
  });

  it("withdraws nothing when only the stored resume bytes changed", async () => {
    const decisionId = await approve();
    const result = await submitApplication(
      dbPorts(db, {
        readFile: async () => new Uint8Array([1, 2, 3]),
        openDriver: driver(confirmed),
      }),
      { candidateId, decisionId, package: pkg },
    );
    expect([result, (await withdrawnEvents()).length]).toEqual([
      { ok: false, error: { kind: "FileChanged", file: "resume" } },
      0,
    ]);
  });
});
