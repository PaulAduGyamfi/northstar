import { type Db, transitionApplication } from "@northstar/db";
import { ApplicationId, type CandidateId } from "@northstar/domain";

// Paul's "I submitted it" on a handoff (NS-121) on packages/db's one write path for status
// changes. He finished the form by hand after a challenge, so it went out as `handoff` (INB-007).
export async function markHandoffSubmitted(
  db: Db,
  candidateId: CandidateId,
  applicationId: string,
  idempotencyKey: string,
): Promise<{ ok: boolean }> {
  const moved = await transitionApplication(db, {
    candidateId,
    applicationId: ApplicationId.parse(applicationId),
    from: "needs_human",
    to: "submitted",
    submittedVia: "handoff",
    actor: "user",
    reason: "",
    inputsSummary: "",
    links: [],
    idempotencyKey,
  });
  return { ok: moved.ok };
}
