import { MAX_APPROVAL_PUSHES_PER_PASS } from "@northstar/db";
import { type CandidateId, PUSH_REQUEST_KINDS, type PushRequestKind } from "@northstar/domain";
import type { ClaimedItem, NotifyPorts } from "./notify.js";

// The notifier's approval step (NS-204 slice 2, APR-003): each request newly waiting in Paul's
// Queue gets one push, at most once. The first MAX_APPROVAL_PUSHES_PER_PASS of a pass go out one
// by one, each opening its request in the Queue; the rest of the pass's requests are claimed too
// and share one overflow push ("N more waiting in the Queue"), so a burst never floods Paul's
// phone and none is pushed again later. A push names a request's id and kind code only, and
// never approves: Paul approves in the Queue, signed in (decision on #162).

type ApprovalPorts = Pick<
  NotifyPorts,
  "isOn" | "approvalsToNotify" | "claimApproval" | "recordApproval"
>;

const KINDS: ReadonlySet<string> = new Set(PUSH_REQUEST_KINDS);

// "done" when the step finished, "switched_off" when Paul turned push off mid-step, "held" when
// every send of a push was held back, so the pass stops (pushOne's own rule).
export async function pushApprovals(
  ports: ApprovalPorts,
  candidateId: CandidateId,
  pushOne: (item: ClaimedItem) => Promise<boolean>,
): Promise<"done" | "switched_off" | "held"> {
  let alone = 0;
  const covered: Array<{ notificationId: string; requestId: string }> = [];
  for (const request of await ports.approvalsToNotify(candidateId)) {
    // Only a kind a push has words for; anything else (a reveal) is never pushed or claimed.
    if (!KINDS.has(request.kind)) continue;
    // Asked before each claim of a push of its own, as for handoffs. Overflow claims are only
    // asked once, when they start: they are fast and lead to one push, which the sender holds back
    // if push was switched off meanwhile (recorded as held, never re-sent).
    // (No overflow claim is taken until the pushes of their own are done, so nothing claimed is
    // left without a push when this returns.)
    const asks = alone < MAX_APPROVAL_PUSHES_PER_PASS || covered.length === 0;
    if (asks && !(await ports.isOn(candidateId))) return "switched_off";
    const claim = await ports.claimApproval(candidateId, request.requestId);
    if (claim.kind !== "claimed") continue;
    if (alone < MAX_APPROVAL_PUSHES_PER_PASS) {
      alone++;
      const one = { notificationId: claim.notificationId, requestId: request.requestId };
      const go = await pushOne({
        notificationId: claim.notificationId,
        payload: {
          v: 1,
          kind: "approval",
          id: request.requestId,
          request: request.kind as PushRequestKind,
        },
        record: (counts) =>
          ports.recordApproval(candidateId, { covered: [one], overflow: false, ...counts }),
        letterSubject: `approval:${request.requestId}`,
      });
      // Every send held back: the rest stay unclaimed for a pass the breaker allows.
      if (!go) return "held";
      continue;
    }
    covered.push({ notificationId: claim.notificationId, requestId: request.requestId });
  }
  const [first] = covered;
  if (!first) return "done";
  // The reader reads at most MAX_APPROVALS_READ, so the count fits the payload's bound.
  const go = await pushOne({
    notificationId: first.notificationId,
    payload: { v: 1, kind: "approvals_waiting", more: covered.length },
    record: (counts) => ports.recordApproval(candidateId, { covered, overflow: true, ...counts }),
    letterSubject: `candidate:${candidateId}`,
  });
  return go ? "done" : "held";
}
