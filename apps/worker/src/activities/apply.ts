import { type ApplicationPackage, CandidateId, type Result } from "@northstar/domain";
import {
  type ApplyStep,
  NotApprovedError,
  type SubmitInput,
  type SubmitOutcome,
  type SubmitRefusal,
} from "@northstar/gateways";
import { ApplicationFailure } from "@temporalio/common";
import { extraKeyProblem, inputProblem } from "../workflows/ending.js";
import { NOT_APPROVED, type SubmitStep, UNDO_WINDOW_OPEN } from "../workflows/types.js";

// The apply-browser pool's activity (NS-157): one call to the Apply Gateway, which checks the
// approval itself, claims the submission once and drives the form (ADR-0002). This wrapper only
// turns its answer into plain data the workflow can decide on.

// Extra wait past the undo window's end (NS-234), for clock skew between worker and database.
const CLOCK_MARGIN_MS = 1_000;

// What the workflow passes in: ids and the package's hash only (NS-242), since Temporal keeps
// activity arguments as plain text in its history. They cross Temporal as JSON, so they are
// checked again here rather than trusted.
export type SubmitArgs = {
  candidateId: string;
  applicationId: string;
  decisionId: string;
  packageSha256: string;
};

const ARG_KEYS = ["applicationId", "candidateId", "decisionId", "packageSha256"] as const;

// The gateway, told where to report its browser steps (NS-225 slice 4).
type Submit = (
  input: SubmitInput,
  onStep: (step: ApplyStep) => void,
) => Promise<Result<SubmitOutcome, SubmitRefusal>>;

// How often the activity tells Temporal it is alive (RES-005), well inside the workflow's
// heartbeat timeout, so a worker that dies mid-step is noticed in about a minute instead of after
// the 10-minute start-to-close. Ten-fold below the 5-minute submit step, so a long submit isn't
// mistaken for a dead one.
export const BEAT_MS = 20_000;

// What the heartbeat says: the step running now. Never a field value, URL or page.
export type BeatStep = "load" | ApplyStep;

// Loads the package stored behind the decision, refusing one that isn't the package named
// (readDecisionPackage in packages/db, bound by the worker process).
export type LoadPackage = (
  candidateId: CandidateId,
  named: { decisionId: string; applicationId: string; contentSha256: string },
) => Promise<Result<ApplicationPackage, { kind: "NoPackage" | "Mismatch" }>>;

// The not_approved reason for each load refusal: the run ends without retry and NS-226 records
// it as a dead letter. Not the Gate's kinds, so nobody reads one as Paul's decision. The reader
// hands out only the package the Gate pinned, so the gateway's ContentChanged path (NS-211's
// withdrawal, NS-234's wait) can't happen through this activity any more: a hash mismatch ends
// here as PackageMismatch and leaves the approval live, which covers only the stored package.
const LOAD_REASONS = { NoPackage: "NoPackage", Mismatch: "PackageMismatch" } as const;

// `submit` is the gateway bound to its ports (submitApplication with dbPorts); `load` reads the
// approved package; `now` is the activity's clock, used only to turn a refusal's retryAt into a
// wait; `beat` is Temporal's activity heartbeat (bound by the worker), told the current step at
// once, on every step and every BEAT_MS until the call ends.
export function createApplyActivities(
  submit: Submit,
  load: LoadPackage,
  now: () => Date = () => new Date(),
  beat: (step: BeatStep) => void = () => {},
) {
  return {
    async submitApplication(args: SubmitArgs): Promise<SubmitStep> {
      let current: BeatStep = "load";
      const tick = () => {
        try {
          beat(current);
        } catch {
          // A heartbeat that can't be sent never changes the submission; Temporal's timeout
          // notices a dead worker, not a failed beat.
        }
      };
      tick();
      const handle = setInterval(tick, BEAT_MS);
      try {
        return await submitOnce(args, (step) => {
          current = step;
          tick();
        });
      } finally {
        clearInterval(handle);
      }
    },
  };

  async function submitOnce(
    args: SubmitArgs,
    onStep: (step: ApplyStep) => void,
  ): Promise<SubmitStep> {
    // Bad input never gets better on a retry: the same checks as the workflow's input, plus
    // the decision id (the database reader reads a malformed one as no package).
    // Not an object at all: refused here rather than thrown as a TypeError and retried.
    if (typeof args !== "object" || args === null) {
      throw ApplicationFailure.nonRetryable("arguments are not an object", "InvalidInput");
    }
    const { decisionId, ...rest } = args;
    const problem =
      extraKeyProblem(args, ARG_KEYS) ??
      (typeof decisionId === "string" ? inputProblem(rest) : "decisionId is not a string");
    if (problem !== null) throw ApplicationFailure.nonRetryable(problem, "InvalidInput");
    const candidateId = CandidateId.parse(args.candidateId);
    // A database error here is thrown and retried by the activity's retry policy.
    const loaded = await load(candidateId, {
      decisionId,
      applicationId: args.applicationId,
      contentSha256: args.packageSha256,
    });
    if (!loaded.ok) {
      throw ApplicationFailure.nonRetryable(LOAD_REASONS[loaded.error.kind], NOT_APPROVED);
    }
    const input: SubmitInput = { candidateId, decisionId, package: loaded.value };
    let result: Result<SubmitOutcome, SubmitRefusal>;
    try {
      result = await submit(input, onStep);
    } catch (error) {
      // Approved, but inside the 2-minute undo window (ADR-0017): not a refusal for good. The
      // workflow waits it out and asks again (.claude/rules/gateways.md: never a silent drop).
      if (error instanceof NotApprovedError && error.reason === UNDO_WINDOW_OPEN) {
        return { kind: "refused", refusal: UNDO_WINDOW_OPEN, waitMs: null };
      }
      // The package changed inside the undo window (NS-234): the gateway's withdrawal was
      // refused until the window ends, so wait for it and call again. The next call withdraws
      // the approval, then ends as not_approved, which NS-226 records as a dead letter.
      if (
        error instanceof NotApprovedError &&
        error.reason === "ContentChanged" &&
        error.retryAt instanceof Date
      ) {
        // A second past the window: the Gate decides by the database's clock, and a worker
        // clock running ahead would otherwise come back just before the window ends.
        const waitMs = Math.max(0, error.retryAt.getTime() - now().getTime()) + CLOCK_MARGIN_MS;
        return { kind: "refused", refusal: UNDO_WINDOW_OPEN, waitMs };
      }
      if (error instanceof NotApprovedError) {
        // The message is the Gate's refusal kind (Rejected, Undone...), which the workflow
        // returns as its not_approved reason.
        throw ApplicationFailure.nonRetryable(error.reason, NOT_APPROVED);
      }
      // Anything else (database down, an invariant) is retried by the activity's retry
      // policy: a repeat is safe because the gateway's claim finds the earlier attempt.
      throw error;
    }
    if (result.ok) {
      const v = result.value;
      return {
        kind: "done",
        outcome: v.outcome,
        submissionId: v.submissionId,
        reason: v.outcome === "needs_human" ? v.reason : null,
        replayed: v.replayed,
      };
    }
    return { kind: "refused", refusal: result.error.kind, waitMs: waitFor(result.error, now()) };
  }
}

export type ApplyActivities = ReturnType<typeof createApplyActivities>;

// Milliseconds until the refusal's retryAt, or null when it gave none.
function waitFor(refusal: SubmitRefusal, at: Date): number | null {
  const retryAt = "retryAt" in refusal ? refusal.retryAt : null;
  return retryAt === null ? null : Math.max(0, retryAt.getTime() - at.getTime());
}
