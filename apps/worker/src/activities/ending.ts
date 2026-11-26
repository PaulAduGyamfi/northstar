import { type Db, recordDeadLetter } from "@northstar/db";
import { CandidateId } from "@northstar/domain";
import { ApplicationFailure } from "@temporalio/common";
import { endingKey } from "../workflows/ending.js";

// The pipeline pool's activity that records a submission workflow's ending as a dead letter
// (NS-226, RES-007, ADR-0007: never a silent drop). recordDeadLetter writes the
// `dead_letter.recorded` feed event in the same transaction, so one ending is one letter and one
// feed line (OBS-001). Ids and codes only: never the package or a message.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type EndingArgs = {
  candidateId: string;
  applicationId: string;
  // The workflow run: the letter's key, one per run.
  runId: string;
  reasonCode: string;
  // Gateway calls made (or the activity's attempts for activity_failed).
  attempts: number;
};

// Bad input never improves on a retry.
const invalid = (what: string) => ApplicationFailure.nonRetryable(what, "InvalidInput");

export function createEndingActivities(db: Db) {
  return {
    async recordSubmissionEnding(args: EndingArgs): Promise<{ status: "recorded" | "exists" }> {
      // Ids cross Temporal as JSON: checked again here rather than trusted as branded.
      const candidateId = CandidateId.safeParse(args.candidateId);
      if (!candidateId.success) throw invalid("candidateId is not a uuid");
      if (!UUID.test(args.applicationId)) throw invalid("applicationId is not a uuid");
      if (!UUID.test(args.runId)) throw invalid("runId is not a uuid");
      const result = await recordDeadLetter(db, {
        candidateId: candidateId.data,
        kind: "apply.submission",
        subject: `application:${args.applicationId}`,
        reasonCode: args.reasonCode,
        attempts: args.attempts,
        idempotencyKey: endingKey(args.applicationId, args.runId),
      });
      // A malformed letter is a bug in this code, not a passing fault.
      if (!result.ok) throw invalid(`invalid dead letter: ${result.error.field}`);
      return { status: result.value.status };
    },
  };
}

export type EndingActivities = ReturnType<typeof createEndingActivities>;
