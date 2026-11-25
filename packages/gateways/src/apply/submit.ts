import { createHash } from "node:crypto";
import {
  ApplicationId,
  type ApplicationPackage,
  type ApplicationStatus,
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
import { mapPackage } from "./map.js";
import type { ApplyPorts } from "./ports.js";

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
export type SubmitRefusal =
  | InvalidPackage
  | HostNotAllowed
  | FileChanged
  | { kind: "DuplicateRequisition" }
  | { kind: "AtsBusy" }
  | { kind: "Paced"; retryAt: Date }
  | { kind: "DailyCapReached"; retryAt: Date };

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

  // 3. Claim it once.
  const claim = await ports.claimSubmission({
    candidateId: input.candidateId,
    applicationId: pkg.applicationId,
    decisionId: verified.value.decisionId,
    ats: pkg.ats,
    postingId: pkg.postingId,
  });
  if (!claim.ok) return claim;
  const applicationId = ApplicationId.parse(pkg.applicationId);
  const { submission } = claim.value;
  const id = submission.submissionId;

  // Moves the application; keyed per submission and target, so a repeat writes one event.
  const move = async (from: ApplicationStatus, to: ApplicationStatus) =>
    ports.transitionApplication({
      candidateId: input.candidateId,
      applicationId,
      from,
      to,
      actor: "agent:apply",
      reason: "",
      inputsSummary: "",
      links: [],
      idempotencyKey: `apply_submission:${id}:${to}`,
    });
  const handOff = async (reason: NeedsHumanReason, from: ApplicationStatus | null) => {
    await ports.recordNeedsHuman(input.candidateId, id, reason);
    if (from !== null) await move(from, "needs_human");
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
    // In progress from an earlier run that never finished: it may have gone out. Never retry.
    // The crash may have come before the move to submitting; the state machine only reaches
    // needs_human through submitting.
    const moved = await move("submitting", "needs_human");
    if (
      !moved.ok &&
      moved.error.kind === "StaleStatus" &&
      moved.error.actual === "awaiting_approval"
    ) {
      const started = await move("awaiting_approval", "submitting");
      if (started.ok) await move("submitting", "needs_human");
    }
    await ports.recordNeedsHuman(input.candidateId, id, "outcome_unknown");
    return ok({
      outcome: "needs_human",
      submissionId: id,
      reason: "outcome_unknown",
      replayed: false,
    });
  }

  // 4. Only an application awaiting approval may go out.
  const started = await move("awaiting_approval", "submitting");
  if (!started.ok) return handOff("status_conflict", null);

  // 5. The browser: one session, closed whatever happens.
  const driven = await drive(ports.openDriver(), adapter, pkg, resume, coverLetter);
  if (driven.kind === "handoff") return handOff(driven.reason, "submitting");

  // 6. Proof, then the status.
  const recorded = await ports.recordSubmitted(input.candidateId, id, {
    confirmationHtml: driven.page.html,
    screenshotPng: driven.page.screenshotPng,
    fieldValues: driven.fieldValues,
    resumeSha256: pkg.resume.sha256,
  });
  // Only this run holds the claim; another writer finishing it is a bug, not an outcome.
  if (!recorded.ok) throw new Error(`apply_submission ${id} was finished by another writer`);
  await move("submitting", "submitted");
  return ok({
    outcome: "submitted",
    submissionId: id,
    proofId: recorded.value.proof.proofId,
    replayed: false,
  });
}

type Confirmed = Extract<PageState, { kind: "page" }>;
type Driven =
  | { kind: "handoff"; reason: NeedsHumanReason }
  | { kind: "confirmed"; page: Confirmed; fieldValues: Record<string, string | string[]> };

// Opens the form, maps the package onto it, submits, and checks for the ATS's confirmation. Any
// browser error ends in a handoff: once submit was pressed it may or may not have gone out, so
// Paul checks and the gateway never retries.
async function drive(
  driver: FormDriver,
  adapter: AtsAdapter,
  pkg: ApplicationPackage,
  resume: Uint8Array,
  coverLetter: Uint8Array | null,
): Promise<Driven> {
  const handoff = (reason: NeedsHumanReason): Driven => ({ kind: "handoff", reason });
  try {
    const page = await driver.open(pkg.applyUrl);
    if (page.kind === "challenge") return handoff(page.challenge);
    if (page.kind !== "form") return handoff("form_changed");
    const plan = mapPackage(adapter, page.fields, pkg);
    if (!plan.ok) return handoff(plan.error.kind);
    const uploads: Upload[] = [];
    for (const f of plan.value.files) {
      const file = f.kind === "resume" ? pkg.resume : pkg.coverLetter;
      const bytes = f.kind === "resume" ? resume : coverLetter;
      if (file === null || bytes === null) return handoff("form_changed");
      uploads.push({ field: f.field, fileName: file.fileName, bytes });
    }
    const after = await driver.fillAndSubmit(plan.value.fills, uploads);
    if (after.kind === "challenge") return handoff(after.challenge);
    if (after.kind !== "page" || !adapter.isConfirmation(after)) return handoff("no_confirmation");
    const fieldValues: Record<string, string | string[]> = {};
    for (const fill of plan.value.fills) {
      fieldValues[fill.field] = typeof fill.value === "string" ? fill.value : [...fill.value];
    }
    for (const upload of uploads) fieldValues[upload.field] = upload.fileName;
    return { kind: "confirmed", page: after, fieldValues };
  } catch {
    return handoff("driver_error");
  } finally {
    await closeQuietly(driver);
  }
}

async function closeQuietly(driver: FormDriver): Promise<void> {
  try {
    await driver.close();
  } catch {
    // A browser that won't close is the worker pool's problem (recycled, ADR-0007), not this
    // submission's: its outcome is already recorded.
  }
}
