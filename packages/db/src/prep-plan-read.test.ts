import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideApprovals, undoDecision, withdrawApproval } from "./approval-write.js";
import type { Db } from "./db.js";
import { proposeInterviewPrep } from "./interview-prep-write.js";
import { decideInterview, recordInterviewDetection } from "./interview-write.js";
import { recordPrepWrite } from "./prep-ledger-write.js";
import { readApprovedPrepPlans, readPrepPlanView } from "./prep-plan-read.js";
import { requestPrepPlanApproval } from "./prep-plan-write.js";
import { createTestDb, seedApplication, setGateClock } from "./test/pglite.js";

// The approved prep plans `funnel prep` writes (NS-241 slice 5) on PGlite. Invented ids only.

const T0 = new Date("2026-11-27T06:00:00.000Z");
// Past the Gate's 2-minute undo window.
const AFTER_UNDO = 3 * 60 * 1000;

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let applicationId: string;
let events = 0;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "submitted");
  candidateId = CandidateId.parse(seeded.candidateId);
  applicationId = seeded.applicationId;
  await setGateClock(db, T0);
});
afterEach(() => close());

// A confirmed interview with a stored proposal, filed as a prep_plan request.
async function filedPlan(owner = candidateId, application = applicationId) {
  events += 1;
  const stored = await recordInterviewDetection(db, {
    candidateId: owner,
    detection: {
      applicationId: application,
      calendarEventId: `evt${String(events).padStart(8, "0")}`,
      format: "technical",
      start: new Date("2026-12-01T15:00:00Z"),
      end: new Date("2026-12-01T16:00:00Z"),
      interviewerCount: 1,
    },
  });
  if (!stored.ok) throw new Error(stored.error.kind);
  const detectionId = stored.value.detectionId;
  const decided = await decideInterview(db, {
    candidateId: owner,
    detectionId,
    decision: "confirmed",
  });
  if (!decided.ok) throw new Error(decided.error.kind);
  const proposed = await proposeInterviewPrep(db, {
    candidateId: owner,
    detectionId,
    request: {
      busy: [],
      workingHours: { start: 540, end: 1020 },
      timeZone: "UTC",
      now: new Date("2026-11-27T12:00:00Z"),
    },
  });
  if (!proposed.ok) throw new Error(proposed.error.kind);
  const filed = await requestPrepPlanApproval(db, {
    candidateId: owner,
    proposalId: proposed.value.proposal.proposalId,
  });
  if (!filed.ok) throw new Error(filed.error.kind);
  return { requestId: filed.value.requestId, proposalId: proposed.value.proposal.proposalId };
}

// Approves a request and gives back its decision id.
async function approve(requestId: string, owner = candidateId): Promise<string> {
  const decided = await decideApprovals(db, {
    candidateId: owner,
    requestIds: [requestId],
    decision: "approve",
  });
  if (!decided.ok) throw new Error(decided.error.kind);
  const result = decided.value[0]?.result;
  if (!result?.ok) throw new Error("not decided");
  return result.value.decisionId;
}

const later = () => setGateClock(db, new Date(T0.getTime() + AFTER_UNDO));

describe("readApprovedPrepPlans", () => {
  it("lists an approval once its undo window has passed", async () => {
    const plan = await filedPlan();
    const decisionId = await approve(plan.requestId);
    await later();
    expect(await readApprovedPrepPlans(db, candidateId)).toEqual([
      { requestId: plan.requestId, decisionId },
    ]);
  });

  it("leaves out a pending request and an approval still in its undo window", async () => {
    await filedPlan();
    const inWindow = await filedPlan();
    await approve(inWindow.requestId);
    expect(await readApprovedPrepPlans(db, candidateId)).toEqual([]);
  });

  it("leaves out a rejection, an undone approval and a withdrawn request", async () => {
    const rejected = await filedPlan();
    const decided = await decideApprovals(db, {
      candidateId,
      requestIds: [rejected.requestId],
      decision: "reject",
      reason: "Not this week",
    });
    if (!decided.ok) throw new Error(decided.error.kind);
    const undone = await filedPlan();
    const undoneDecision = await approve(undone.requestId);
    const undo = await undoDecision(db, { candidateId, decisionId: undoneDecision });
    if (!undo.ok) throw new Error(undo.error.kind);
    const withdrawn = await filedPlan();
    await approve(withdrawn.requestId);
    await later();
    const closed = await withdrawApproval(db, {
      candidateId,
      requestId: withdrawn.requestId,
      by: "user",
    });
    if (!closed.ok) throw new Error(closed.error.kind);
    expect(await readApprovedPrepPlans(db, candidateId)).toEqual([]);
  });

  it("leaves out a decision already written", async () => {
    const plan = await filedPlan();
    const decisionId = await approve(plan.requestId);
    await later();
    await recordPrepWrite(db, candidateId, {
      decisionId,
      proposalId: plan.proposalId,
      blockCount: 3,
    });
    expect(await readApprovedPrepPlans(db, candidateId)).toEqual([]);
  });

  it("leaves out another candidate's approved plan", async () => {
    const other = await seedApplication(db, "submitted");
    const otherId = CandidateId.parse(other.candidateId);
    const plan = await filedPlan(otherId, other.applicationId);
    await approve(plan.requestId, otherId);
    await later();
    expect([
      await readApprovedPrepPlans(db, candidateId),
      (await readApprovedPrepPlans(db, otherId)).map((p) => p.requestId),
    ]).toEqual([[], [plan.requestId]]);
  });
});

describe("readPrepPlanView", () => {
  it("gives the interview it was filed for and its blocks in time order", async () => {
    const plan = await filedPlan();
    const view = await readPrepPlanView(db, candidateId, plan.requestId);
    expect([
      view?.interview,
      view?.rescheduled,
      view?.blocks.map((b) => b.kind),
      view?.blocks.every(
        (b, i, all) => i === 0 || (all[i - 1]?.start.getTime() ?? 0) <= b.start.getTime(),
      ),
    ]).toEqual([
      { start: new Date("2026-12-01T15:00:00Z"), end: new Date("2026-12-01T16:00:00Z") },
      false,
      ["prep", "prep", "warm_up"],
      true,
    ]);
  });

  it("says rescheduled once a newer version of the interview is stored", async () => {
    const plan = await filedPlan();
    const moved = await recordInterviewDetection(db, {
      candidateId,
      detection: {
        applicationId,
        calendarEventId: `evt${String(events).padStart(8, "0")}`,
        format: "technical",
        start: new Date("2026-12-02T15:00:00Z"),
        end: new Date("2026-12-02T16:00:00Z"),
        interviewerCount: 1,
      },
    });
    if (!moved.ok) throw new Error(moved.error.kind);
    const view = await readPrepPlanView(db, candidateId, plan.requestId);
    expect([view?.rescheduled, view?.interview.start]).toEqual([
      true,
      new Date("2026-12-01T15:00:00Z"),
    ]);
  });

  it("answers null for another candidate's plan and for an id that names no plan", async () => {
    const other = await seedApplication(db, "submitted");
    const otherId = CandidateId.parse(other.candidateId);
    const plan = await filedPlan(otherId, other.applicationId);
    expect([
      await readPrepPlanView(db, candidateId, plan.requestId),
      await readPrepPlanView(db, candidateId, "00000000-0000-4000-8000-000000000999"),
      await readPrepPlanView(db, candidateId, "not-a-uuid"),
    ]).toEqual([null, null, null]);
  });
});
