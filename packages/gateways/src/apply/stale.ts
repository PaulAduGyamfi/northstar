import type { SubmissionView } from "@northstar/db";
import { ApplicationId, type ApplicationStatus, type CandidateId } from "@northstar/domain";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ApplyPorts } from "./ports.js";

// Closing a claim whose run died (NS-120, NS-143). One helper for the two paths that find one: a
// repeated submitApplication and the sweep. A dead run may have gone out, so it is never retried:
// the ledger row becomes needs_human (outcome_unknown), which frees the ATS lane, then the
// application follows, with the gateway's key namespace so a repeat writes one event.

export type StalePorts = Pick<ApplyPorts, "recordNeedsHuman" | "transitionApplication">;

// A status move that should always succeed didn't: the ledger and the application disagree, so
// stop loudly instead of reporting an outcome (ADR-0007). Declared here so both paths share it.
export class ApplyInvariantError extends Error {
  constructor(what: string) {
    super(`apply gateway invariant broken: ${what}`);
    this.name = "ApplyInvariantError";
  }
}

// The idempotency key of one status move of one submission. The ledger's own events use
// `apply_submission:<id>:<what>`, so the two never collide.
export const applyMoveKey = (
  applicationId: string,
  submissionId: string,
  to: ApplicationStatus,
): string => `application:${applicationId}:apply:${submissionId}:${to}`;

// Returns false when the ledger refused: another caller closed (or finished) it first, and the
// application is theirs to move.
export async function closeStaleClaim(
  ports: StalePorts,
  candidateId: CandidateId,
  submission: Pick<SubmissionView, "submissionId" | "applicationId">,
): Promise<boolean> {
  const recorded = await ports.recordNeedsHuman(
    candidateId,
    submission.submissionId,
    "outcome_unknown",
  );
  if (!recorded.ok) return false;
  await moveToNeedsHuman(ports, candidateId, submission);
  return true;
}

// Moves the application of a claim the ledger already closed as outcome_unknown to needs_human.
// Used right after the ledger write, and by the sweep for a close whose run crashed between the
// two (NS-177). The keys are the gateway's own (applyMoveKey), so a move already made, by this
// path, a racing sweep or a repeated submitApplication, replays instead of writing again.
async function moveToNeedsHuman(
  ports: StalePorts,
  candidateId: CandidateId,
  submission: Pick<SubmissionView, "submissionId" | "applicationId">,
): Promise<void> {
  const id = submission.submissionId;
  const applicationId = ApplicationId.parse(submission.applicationId);
  const move = (from: ApplicationStatus, to: ApplicationStatus) =>
    ports.transitionApplication({
      candidateId,
      applicationId,
      from,
      to,
      actor: "agent:apply",
      reason: "",
      inputsSummary: "",
      links: [],
      idempotencyKey: applyMoveKey(applicationId, id, to),
    });
  const mustMove = async (from: ApplicationStatus, to: ApplicationStatus) => {
    const moved = await move(from, to);
    if (!moved.ok) throw new ApplyInvariantError(`move ${from} to ${to}: ${moved.error.kind}`);
  };
  // The run may have died before its move to submitting; the state machine reaches needs_human
  // only through it.
  const moved = await move("submitting", "needs_human");
  if (!moved.ok) {
    if (moved.error.kind !== "StaleStatus" || moved.error.actual !== "awaiting_approval") {
      throw new ApplyInvariantError(`move submitting to needs_human: ${moved.error.kind}`);
    }
    await mustMove("awaiting_approval", "submitting");
    await mustMove("submitting", "needs_human");
  }
}

export type SweepPorts = StalePorts & {
  listStaleClaims: (candidateId: CandidateId) => Promise<SubmissionView[]>;
  listHalfClosedClaims: (candidateId: CandidateId) => Promise<SubmissionView[]>;
};

// Closes every claim of this candidate that died in progress (NS-143), so its ATS lane frees up
// and Paul sees it as needs_human without waiting for the same application to come round again.
// Then finishes the application move of every claim closed without one (NS-177). Safe to repeat:
// a second sweep finds nothing. Returns the submission ids it closed or repaired. One claim
// that fails doesn't keep the others' lanes stuck (ADR-0007, fail small): the pass goes on and
// throws the first failure at the end, so the caller still sees it.
export async function sweepStaleClaims(
  ports: SweepPorts,
  candidateId: CandidateId,
): Promise<string[]> {
  return trace.getTracer("@northstar/gateways").startActiveSpan("apply.sweep", async (span) => {
    try {
      const closed: string[] = [];
      const failures: unknown[] = [];
      for (const claim of await ports.listStaleClaims(candidateId)) {
        try {
          if (await closeStaleClaim(ports, candidateId, claim)) closed.push(claim.submissionId);
        } catch (error) {
          failures.push(error);
        }
      }
      const staleCount = closed.length;
      // Read after the closes above, so a close that just failed its move is retried here once.
      for (const claim of await ports.listHalfClosedClaims(candidateId)) {
        try {
          await moveToNeedsHuman(ports, candidateId, claim);
          if (!closed.includes(claim.submissionId)) closed.push(claim.submissionId);
        } catch (error) {
          failures.push(error);
        }
      }
      span.setAttribute("northstar.apply.stale_count", staleCount);
      span.setAttribute("northstar.apply.repaired_count", closed.length - staleCount);
      span.setAttribute("northstar.apply.failed_count", failures.length);
      if (failures.length > 0) throw failures[0];
      return closed;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "SweepError" });
      throw error;
    } finally {
      span.end();
    }
  });
}
