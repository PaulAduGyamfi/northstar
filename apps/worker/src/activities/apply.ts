import { CandidateId, type Result } from "@northstar/domain";
import {
  NotApprovedError,
  type SubmitInput,
  type SubmitOutcome,
  type SubmitRefusal,
} from "@northstar/gateways";
import { ApplicationFailure } from "@temporalio/common";
import { NOT_APPROVED, type SubmitStep, UNDO_WINDOW_OPEN } from "../workflows/types.js";

// The apply-browser pool's activity (NS-157): one call to the Apply Gateway, which checks the
// approval itself, claims the submission once and drives the form (ADR-0002). This wrapper only
// turns its answer into plain data the workflow can decide on.

// What the workflow passes in. Activity arguments cross Temporal as JSON, so the candidate id is
// checked again here rather than trusted as branded.
export type SubmitArgs = { candidateId: string; decisionId: string; package: unknown };

type Submit = (input: SubmitInput) => Promise<Result<SubmitOutcome, SubmitRefusal>>;

// `submit` is the gateway bound to its ports (submitApplication with dbPorts); `now` is the
// activity's clock, used only to turn a refusal's retryAt into a wait.
export function createApplyActivities(submit: Submit, now: () => Date = () => new Date()) {
  return {
    async submitApplication(args: SubmitArgs): Promise<SubmitStep> {
      const candidateId = CandidateId.safeParse(args.candidateId);
      // Bad input never gets better on a retry.
      if (!candidateId.success) {
        throw ApplicationFailure.nonRetryable("candidateId is not a uuid", "InvalidInput");
      }
      const input: SubmitInput = {
        candidateId: candidateId.data,
        decisionId: args.decisionId,
        package: args.package,
      };
      let result: Result<SubmitOutcome, SubmitRefusal>;
      try {
        result = await submit(input);
      } catch (error) {
        // Approved, but inside the 2-minute undo window (ADR-0017): not a refusal for good. The
        // workflow waits it out and asks again (.claude/rules/gateways.md: never a silent drop).
        if (error instanceof NotApprovedError && error.reason === UNDO_WINDOW_OPEN) {
          return { kind: "refused", refusal: UNDO_WINDOW_OPEN, waitMs: null };
        }
        // The package changed inside the undo window (NS-234): the gateway's withdrawal was
        // refused until the window ends, so wait for it and call again. The next call withdraws
        // the approval, then ends as not_approved, which NS-226 records as a dead letter.
        if (error instanceof NotApprovedError && error.retryAt instanceof Date) {
          const waitMs = Math.max(0, error.retryAt.getTime() - now().getTime());
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
    },
  };
}

export type ApplyActivities = ReturnType<typeof createApplyActivities>;

// Milliseconds until the refusal's retryAt, or null when it gave none.
function waitFor(refusal: SubmitRefusal, at: Date): number | null {
  const retryAt = "retryAt" in refusal ? refusal.retryAt : null;
  return retryAt === null ? null : Math.max(0, retryAt.getTime() - at.getTime());
}
