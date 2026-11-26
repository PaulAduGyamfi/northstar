import { createHash } from "node:crypto";
import {
  ApplicationId,
  type ApplicationPackage,
  type ApplicationStatus,
  type CallOutcome,
  type CandidateId,
  err,
  type InvalidPackage,
  type NeedsHumanReason,
  ok,
  packageSha256,
  packageSubject,
  parsePackage,
  type Result,
} from "@northstar/domain";
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { type AtsAdapter, adapterFor, hostAllowed } from "./adapters/index.js";
import type { FormDriver, PageState, Upload } from "./driver.js";
import { admit, atsDependency } from "./guard.js";
import { mapPackage } from "./map.js";
import type { ApplyPorts } from "./ports.js";
import { ApplyInvariantError, applyMoveKey, closeStaleClaim } from "./stale.js";

// The Apply Gateway (NS-120, ADR-0002): the only code that submits an application. It checks
// the approval with the Gate at the moment it acts, claims the submission once (idempotency,
// requisition dedupe, pacing), drives the form, and stores proof. Anything it can't finish ends
// as needs_human with a reason code, never a silent drop and never a blind retry.

export type SubmitInput = {
  candidateId: CandidateId;
  // The approvalId or policyDecisionId the caller was handed. Looked up, never trusted.
  decisionId: string;
  // Parsed here: the gateway checks it, whoever built it.
  package: unknown;
};

export type SubmitOutcome =
  | { outcome: "submitted"; submissionId: string; proofId: string; replayed: boolean }
  | { outcome: "needs_human"; submissionId: string; reason: NeedsHumanReason; replayed: boolean };

export type HostNotAllowed = { kind: "HostNotAllowed" };
// Thrown when the Gate doesn't verify the decision id for exactly this package. `reason` is the
// Gate's refusal kind (NotFound, Rejected, Undone, UndoWindowOpen, SubjectMismatch, ContentChanged).
export class NotApprovedError extends Error {
  constructor(readonly reason: string) {
    super(`not approved: ${reason}`);
    this.name = "NotApprovedError";
  }
}
export type FileChanged = { kind: "FileChanged"; file: "resume" | "coverLetter" };
// The package's posting id isn't the one in its apply URL.
export type PostingMismatch = { kind: "PostingMismatch" };
// An earlier run holds the claim and may still be in the browser: try again later.
export type InProgress = { kind: "InProgress" };
// A kill switch or the ATS's breaker held the submission back before anything was claimed
// (NS-206; a refusal value, not @northstar/llm's HeldBack error for model calls): call again later (at `retryAt` when the breaker gave one). `what` names the switch
// (auto_apply, adapter:<ats>) or the breaker (ats:<ats>).
export type HeldBack = {
  kind: "HeldBack";
  by: "kill_switch" | "breaker" | "guard_error";
  what: string;
  retryAt: Date | null;
};
export type SubmitRefusal =
  | InvalidPackage
  | HostNotAllowed
  | PostingMismatch
  | FileChanged
  | InProgress
  | HeldBack
  | { kind: "DuplicateRequisition" }
  | { kind: "AtsBusy" }
  | { kind: "Paced"; retryAt: Date }
  | { kind: "DailyCapReached"; retryAt: Date };

// Time limits around each browser step (.claude/rules/gateways.md). Together they stay well under
// CLAIM_STALE_AFTER_MS, so a claim older than that can only belong to a run that died.
export const OPEN_TIMEOUT_MS = 60_000;
export const SUBMIT_TIMEOUT_MS = 5 * 60_000;
export const CLOSE_TIMEOUT_MS = 30_000;

// Thrown when a status move or ledger write that should always succeed didn't (stale.ts).
export { ApplyInvariantError } from "./stale.js";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const tracer = () => trace.getTracer("@northstar/gateways");

export async function submitApplication(
  ports: ApplyPorts,
  input: SubmitInput,
): Promise<Result<SubmitOutcome, SubmitRefusal>> {
  return tracer().startActiveSpan("apply.submit", async (span) => {
    try {
      const result = await submit(ports, input, span);
      const label = result.ok
        ? result.value.replayed
          ? "replayed"
          : result.value.outcome === "submitted"
            ? "submitted"
            : result.value.reason
        : result.error.kind;
      span.setAttribute("northstar.apply.outcome", label);
      if (!result.ok) span.setStatus({ code: SpanStatusCode.ERROR, message: result.error.kind });
      return result;
    } catch (error) {
      const kind = error instanceof NotApprovedError ? "NotApproved" : "GatewayError";
      span.setAttribute("northstar.apply.outcome", kind);
      span.setStatus({ code: SpanStatusCode.ERROR, message: kind });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function submit(
  ports: ApplyPorts,
  input: SubmitInput,
  span: Span,
): Promise<Result<SubmitOutcome, SubmitRefusal>> {
  const parsed = parsePackage(input.package);
  if (!parsed.ok) return parsed;
  const pkg = parsed.value;
  const adapter = adapterFor(pkg.ats);
  span.setAttribute("northstar.apply.ats", pkg.ats);
  if (!hostAllowed(adapter, pkg.applyUrl)) return err({ kind: "HostNotAllowed" });
  // The requisition is the posting the URL opens, not whatever id the producer wrote (APPLY-009).
  const postingId = adapter.postingIdOf(new URL(pkg.applyUrl).pathname);
  if (postingId === null || postingId !== pkg.postingId.toLowerCase()) {
    return err({ kind: "PostingMismatch" });
  }

  // 1. The Gate, now: the id must approve exactly this package, past its undo window.
  const verified = await ports.verifyApproval({
    candidateId: input.candidateId,
    decisionId: input.decisionId,
    kind: "application_package",
    subject: packageSubject(pkg),
    contentSha256: packageSha256(pkg),
  });
  // No verified approval: throw, never a value a caller could ignore (.claude/rules/gateways.md).
  if (!verified.ok) throw new NotApprovedError(verified.error.kind);

  // 2. The files Paul approved, by hash.
  const resume = await ports.readFile(pkg.resume.sha256);
  if (resume === null || sha256(resume) !== pkg.resume.sha256) {
    return err({ kind: "FileChanged", file: "resume" });
  }
  let coverLetter: Uint8Array | null = null;
  if (pkg.coverLetter !== null) {
    coverLetter = await ports.readFile(pkg.coverLetter.sha256);
    if (coverLetter === null || sha256(coverLetter) !== pkg.coverLetter.sha256) {
      return err({ kind: "FileChanged", file: "coverLetter" });
    }
  }

  // 3. The kill switches and the ATS's breaker, now (RES-002, RES-008): held back, nothing is
  // claimed or moved and the browser never opens, so a later call simply tries again.
  const dependency = atsDependency(pkg.ats);
  const admitted = await admit(ports, input.candidateId, pkg.ats, span);
  if (!admitted.ok) return admitted;
  // Only the browser step below reports it: a path that returns before then (a refused claim, a
  // replay, a status conflict) leaves a probe unreported until its 2-minute window ends. That is
  // bounded and fails safe; asking after the claim would leave a claim behind when held back.
  const probeToken = admitted.value;
  // Tells the breaker how the ATS answered. A report that fails is noted, never thrown: the
  // submission's outcome is already decided.
  const report = async (outcome: CallOutcome) => {
    try {
      await ports.recordCallOutcome(input.candidateId, dependency, outcome, probeToken);
    } catch {
      span.setAttribute("northstar.apply.breaker_report_failed", true);
    }
  };

  // 4. Claim it once.
  const claim = await ports.claimSubmission({
    candidateId: input.candidateId,
    applicationId: pkg.applicationId,
    decisionId: verified.value.decisionId,
    ats: pkg.ats,
    postingId,
  });
  if (!claim.ok) return claim;
  const applicationId = ApplicationId.parse(pkg.applicationId);
  const { submission } = claim.value;
  const id = submission.submissionId;

  // Moves the application, one key per submission and target, so a repeat writes one event.
  const move = (from: ApplicationStatus, to: ApplicationStatus) =>
    ports.transitionApplication({
      candidateId: input.candidateId,
      applicationId,
      from,
      to,
      actor: "agent:apply",
      reason: "",
      inputsSummary: "",
      links: [],
      idempotencyKey: applyMoveKey(applicationId, id, to),
      // How it went out (INB-007): the policy's decision is "auto", Paul's is "approved".
      submittedVia: verified.value.decidedBy === "policy" ? "auto" : "approved",
    });
  const mustMove = async (from: ApplicationStatus, to: ApplicationStatus) => {
    const moved = await move(from, to);
    if (!moved.ok) throw new ApplyInvariantError(`move ${from} to ${to}: ${moved.error.kind}`);
  };
  // The ledger first (it frees the ATS lane), then the application. The apply URL (its host
  // already checked above) lets a challenge open a handoff Paul finishes by hand (NS-121).
  const handOff = async (reason: NeedsHumanReason, from: ApplicationStatus | null) => {
    const recorded = await ports.recordNeedsHuman(input.candidateId, id, reason, pkg.applyUrl);
    if (!recorded.ok) throw new ApplyInvariantError(`needs_human: ${recorded.error.kind}`);
    if (from !== null) await mustMove(from, "needs_human");
    return ok({ outcome: "needs_human" as const, submissionId: id, reason, replayed: false });
  };

  if (!claim.value.claimed) {
    if (submission.status === "submitted" && claim.value.proof !== null) {
      return ok({
        outcome: "submitted",
        submissionId: id,
        proofId: claim.value.proof.proofId,
        replayed: true,
      });
    }
    if (submission.status === "needs_human" && submission.reason !== null) {
      return ok({
        outcome: "needs_human",
        submissionId: id,
        reason: submission.reason,
        replayed: true,
      });
    }
    // Another run holds the claim and may still be in the browser: leave it alone.
    if (!claim.value.stale) return err({ kind: "InProgress" });
    // A run that died after its claim: it may have gone out, so never retry (stale.ts).
    if (!(await closeStaleClaim(ports, input.candidateId, submission))) {
      return err({ kind: "InProgress" });
    }
    return ok({
      outcome: "needs_human",
      submissionId: id,
      reason: "outcome_unknown",
      replayed: false,
    });
  }

  // 5. Only an application awaiting approval may go out.
  const started = await move("awaiting_approval", "submitting");
  if (!started.ok) return handOff("status_conflict", null);

  // 6. The browser: one session, closed whatever happens. Only the ATS's own trouble (a step
  // timeout) counts against its breaker; a page it served is it working; a browser crash isn't
  // its fault and isn't reported.
  const driven = await drive(ports.openDriver(), adapter, pkg, resume, coverLetter);
  if (driven.ats !== "unknown") await report(driven.ats);
  if (driven.kind === "handoff") return handOff(driven.reason, "submitting");

  // 7. Proof, then the status. Only this run holds a live claim (a replay leaves it alone until
  // it is stale), so the ledger refusing here means the invariant broke.
  const recorded = await ports.recordSubmitted(input.candidateId, id, {
    confirmationHtml: driven.page.html,
    screenshotPng: driven.page.screenshotPng,
    fieldValues: driven.fieldValues,
    resumeSha256: pkg.resume.sha256,
  });
  if (!recorded.ok) throw new ApplyInvariantError(`submitted: ${recorded.error.kind}`);
  await mustMove("submitting", "submitted");
  return ok({
    outcome: "submitted",
    submissionId: id,
    proofId: recorded.value.proof.proofId,
    replayed: false,
  });
}

type Confirmed = Extract<PageState, { kind: "page" }>;
// `ats` is what the ATS's breaker is told: it answered (ok), it didn't in time (a failure), or
// the browser failed in a way that says nothing about the ATS (unknown, not reported).
type AtsReport = CallOutcome | "unknown";
type Driven =
  | { kind: "handoff"; reason: NeedsHumanReason; ats: AtsReport }
  | {
      kind: "confirmed";
      page: Confirmed;
      fieldValues: Record<string, string | string[]>;
      ats: AtsReport;
    };

class StepTimeout extends Error {}
const OK: CallOutcome = { ok: true };

// Rejects when the step takes longer than ms; the timer never outlives the step.
async function within<T>(ms: number, step: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeout()), ms);
  });
  try {
    return await Promise.race([step, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Opens the form, maps the package onto it, submits, and checks for the ATS's confirmation on
// the ATS's own host. Any browser error or timeout ends in a handoff: once submit was pressed it
// may or may not have gone out, so Paul checks and the gateway never retries.
async function drive(
  driver: FormDriver,
  adapter: AtsAdapter,
  pkg: ApplicationPackage,
  resume: Uint8Array,
  coverLetter: Uint8Array | null,
): Promise<Driven> {
  // Every handoff below follows a page the ATS served, so it answered.
  const handoff = (reason: NeedsHumanReason): Driven => ({ kind: "handoff", reason, ats: OK });
  try {
    const page = await within(OPEN_TIMEOUT_MS, driver.open(pkg.applyUrl));
    if (page.kind === "challenge") return handoff(page.challenge);
    // A form after a redirect off the ATS's hosts is not the form Paul approved sending to.
    if (page.kind !== "form" || !hostAllowed(adapter, page.url)) return handoff("form_changed");
    const plan = mapPackage(adapter, page.fields, pkg);
    if (!plan.ok) return handoff(plan.error.kind);
    const uploads: Upload[] = [];
    for (const f of plan.value.files) {
      const file = f.kind === "resume" ? pkg.resume : pkg.coverLetter;
      const bytes = f.kind === "resume" ? resume : coverLetter;
      if (file === null || bytes === null) return handoff("form_changed");
      uploads.push({ field: f.field, fileName: file.fileName, bytes });
    }
    const after = await within(SUBMIT_TIMEOUT_MS, driver.fillAndSubmit(plan.value.fills, uploads));
    if (after.kind === "challenge") return handoff(after.challenge);
    if (
      after.kind !== "page" ||
      !hostAllowed(adapter, after.url) ||
      !adapter.isConfirmation(after)
    ) {
      return handoff("no_confirmation");
    }
    const fieldValues: Record<string, string | string[]> = {};
    for (const fill of plan.value.fills) {
      fieldValues[fill.field] = typeof fill.value === "string" ? fill.value : [...fill.value];
    }
    for (const upload of uploads) fieldValues[upload.field] = upload.fileName;
    return { kind: "confirmed", page: after, fieldValues, ats: OK };
  } catch (error) {
    // Our step limit, or the browser's own timeout (Playwright's TimeoutError): the ATS didn't
    // answer in time. Anything else (a crashed tab) isn't the ATS's fault.
    const timedOut =
      error instanceof StepTimeout || (error instanceof Error && error.name === "TimeoutError");
    return {
      kind: "handoff",
      reason: "driver_error",
      ats: timedOut ? { ok: false, error: "Timeout" } : "unknown",
    };
  } finally {
    await closeQuietly(driver);
  }
}

async function closeQuietly(driver: FormDriver): Promise<void> {
  try {
    await within(CLOSE_TIMEOUT_MS, driver.close());
  } catch {
    // A browser that won't close is the worker pool's problem (recycled, ADR-0007), not this
    // submission's: its outcome is already recorded.
  }
}
