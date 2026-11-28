import { randomUUID } from "node:crypto";
import { CandidateId, type PolicyRule } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvalEdit } from "./approval-schema.js";
import {
  decideApprovals,
  requestApproval,
  setApprovalPolicies,
  undoDecision,
  withdrawApproval,
} from "./approval-write.js";
import type { Db } from "./db.js";
import {
  approvalNotifyKey,
  claimApprovalNotification,
  MAX_APPROVALS_READ,
  readApprovalsToNotify,
  recordApprovalPushResult,
} from "./push-approval-write.js";
import { readStalePushClaims } from "./push-notify-write.js";
import { pushNotification, pushNotificationResult } from "./push-schema.js";
import { candidate, domainEvent } from "./schema.js";
import { packageFixture } from "./test/package-fixture.js";
import { createTestDb } from "./test/pglite.js";

// Approval pushes' records (NS-204 slice 2) on the real write paths, PGlite. Synthetic requests
// only.

const NOW = new Date("2026-11-25T12:00:00Z");

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

async function setClock(at: Date): Promise<void> {
  await db.execute(sql`select set_config('northstar.gate_test_now', ${at.toISOString()}, false)`);
}

async function newCandidate(): Promise<CandidateId> {
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  return CandidateId.parse(c.id);
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = await newCandidate();
  await setClock(NOW);
});

afterEach(async () => {
  await close();
});

// A synthetic reply request waiting for Paul.
async function waiting(
  options: { who?: CandidateId; subject?: string } = {},
): Promise<{ requestId: string }> {
  const r = await requestApproval(db, {
    candidateId: options.who ?? candidateId,
    kind: "email_reply",
    subject: options.subject ?? `application:${randomUUID()}`,
    contentSha256: "a".repeat(64),
    facts: null,
    actor: "agent:inbox",
    idempotencyKey: randomUUID(),
  });
  if (!r.ok) throw new Error(r.error.kind);
  return { requestId: r.value.requestId };
}

async function decide(requestId: string, decision: "approve" | "reject"): Promise<string> {
  const d = await decideApprovals(db, {
    candidateId,
    requestIds: [requestId],
    decision,
    ...(decision === "reject" ? { reason: "Not for me" } : {}),
  });
  const outcome = d.ok ? d.value[0]?.result : undefined;
  if (!outcome?.ok) throw new Error("not decided");
  return outcome.value.decisionId;
}

const ids = async (who: CandidateId = candidateId) =>
  (await readApprovalsToNotify(db, who)).map((a) => a.requestId);

describe("readApprovalsToNotify (NS-204 slice 2)", () => {
  it("lists a waiting request with its id and kind only", async () => {
    const { requestId } = await waiting();
    expect(await readApprovalsToNotify(db, candidateId)).toEqual([
      { requestId, kind: "email_reply" },
    ]);
  });

  it("lists the oldest first", async () => {
    const a = await waiting();
    await setClock(new Date(NOW.getTime() + 60_000));
    const b = await waiting();
    expect(await ids()).toEqual([a.requestId, b.requestId]);
  });

  it("leaves out a request Paul approved or rejected", async () => {
    const approved = await waiting();
    const rejected = await waiting();
    await decide(approved.requestId, "approve");
    await decide(rejected.requestId, "reject");
    expect(await ids()).toEqual([]);
  });

  it("lists a request again once Paul undoes his decision", async () => {
    const { requestId } = await waiting();
    const decisionId = await decide(requestId, "approve");
    const undone = await undoDecision(db, { candidateId, decisionId });
    expect([undone.ok, await ids()]).toEqual([true, [requestId]]);
  });

  it("leaves out a request Paul withdrew", async () => {
    const { requestId } = await waiting();
    await withdrawApproval(db, { candidateId, requestId, by: "user" });
    expect(await ids()).toEqual([]);
  });

  it("leaves out a request a policy approved, since it never waits for Paul", async () => {
    const rule: PolicyRule = {
      name: "strong fit",
      kind: "application_package",
      minFit: 85,
      allowHighConfidenceAnswers: false,
      maxFreeTextWords: 100,
    };
    await setApprovalPolicies(db, { candidateId, rules: [rule] });
    const fx = await packageFixture(db, candidateId, { now: NOW });
    const filed = await fx.file({ packageId: randomUUID() });
    if (!filed.ok) throw new Error(filed.error.kind);
    // The fixture's own setup files and approves a reply: nothing of either waits.
    expect([filed.value.decision?.decidedBy, await ids()]).toEqual(["policy", []]);
  });

  it("leaves out the request Paul's own edit filed", async () => {
    const subject = `application:${randomUUID()}`;
    const old = await waiting({ subject });
    await withdrawApproval(db, { candidateId, requestId: old.requestId, by: "user" });
    const edited = await waiting({ subject });
    // editRequest's own link, written straight in: only the link matters here.
    await db.insert(approvalEdit).values({
      candidateId,
      previousRequestId: old.requestId,
      requestId: edited.requestId,
      editedAt: NOW,
    });
    expect(await ids()).toEqual([]);
  });

  it("leaves out a request already claimed", async () => {
    const a = await waiting();
    const b = await waiting();
    await claimApprovalNotification(db, candidateId, a.requestId);
    expect(await ids()).toEqual([b.requestId]);
  });

  it("never lists another candidate's request", async () => {
    const other = await newCandidate();
    await waiting({ who: other });
    expect(await ids()).toEqual([]);
  });

  it("reads at most MAX_APPROVALS_READ requests a pass", async () => {
    for (let i = 0; i < MAX_APPROVALS_READ + 1; i++) await waiting();
    expect((await ids()).length).toBe(MAX_APPROVALS_READ);
  });
});

describe("claimApprovalNotification (NS-204 slice 2)", () => {
  it("claims a request once, however many times it is asked", async () => {
    const { requestId } = await waiting();
    const first = await claimApprovalNotification(db, candidateId, requestId);
    const second = await claimApprovalNotification(db, candidateId, requestId);
    const rows = await db.select().from(pushNotification);
    expect([first.kind, second.kind, rows.map((r) => r.itemKey)]).toEqual([
      "claimed",
      "already_claimed",
      [`approval_request:${requestId}:notify`],
    ]);
  });

  it("claims nothing for a request Paul already decided", async () => {
    const { requestId } = await waiting();
    await decide(requestId, "approve");
    expect([
      await claimApprovalNotification(db, candidateId, requestId),
      await db.select().from(pushNotification),
    ]).toEqual([{ kind: "resolved" }, []]);
  });

  it("claims nothing for a withdrawn request", async () => {
    const { requestId } = await waiting();
    await withdrawApproval(db, { candidateId, requestId, by: "user" });
    expect(await claimApprovalNotification(db, candidateId, requestId)).toEqual({
      kind: "resolved",
    });
  });

  it("claims nothing for another candidate's request", async () => {
    const other = await newCandidate();
    const { requestId } = await waiting({ who: other });
    expect([
      await claimApprovalNotification(db, candidateId, requestId),
      await db.select().from(pushNotification),
    ]).toEqual([{ kind: "not_found" }, []]);
  });

  it("keys the claim so the stale-claim reader can report it", async () => {
    const { requestId } = await waiting();
    const claim = await claimApprovalNotification(db, candidateId, requestId);
    if (claim.kind !== "claimed") throw new Error("not claimed");
    // Claims are stamped by now(): twenty minutes past the real clock is past the 15-minute lease.
    await setClock(new Date(Date.now() + 20 * 60_000));
    expect(await readStalePushClaims(db, candidateId)).toEqual([
      { notificationId: claim.notificationId, itemKey: approvalNotifyKey(requestId) },
    ]);
  });
});

describe("recordApprovalPushResult (NS-204 slice 2)", () => {
  async function claimed(): Promise<{ notificationId: string; requestId: string }> {
    const { requestId } = await waiting();
    const claim = await claimApprovalNotification(db, candidateId, requestId);
    if (claim.kind !== "claimed") throw new Error("not claimed");
    return { notificationId: claim.notificationId, requestId };
  }
  const pushEvents = () =>
    db
      .select({
        aggregate: domainEvent.aggregate,
        type: domainEvent.type,
        reason: domainEvent.reason,
        payload: domainEvent.payload,
      })
      .from(domainEvent)
      .where(sql`${domainEvent.type} like 'push.%'`);

  it("records a request's own push once, on that request, with fixed words and counts only", async () => {
    const one = await claimed();
    const input = {
      candidateId,
      covered: [one],
      overflow: false,
      sent: 1,
      gone: 0,
      rejected: 1,
    };
    const first = await recordApprovalPushResult(db, input);
    const second = await recordApprovalPushResult(db, input);
    expect([first, second, await pushEvents()]).toEqual([
      { recorded: true },
      { recorded: false },
      [
        {
          aggregate: `approval:${one.requestId}`,
          type: "push.sent",
          reason: "Sent you a notification: a request is waiting for your approval",
          payload: {
            notificationId: one.notificationId,
            requests: 1,
            sent: 1,
            gone: 0,
            rejected: 1,
          },
        },
      ],
    ]);
  });

  it("records an overflow push against every request it covered, in one feed line", async () => {
    const covered = [await claimed(), await claimed(), await claimed()];
    await recordApprovalPushResult(db, {
      candidateId,
      covered,
      overflow: true,
      sent: 0,
      gone: 1,
      rejected: 0,
    });
    const results = await db
      .select({
        id: pushNotificationResult.notificationId,
        outcome: pushNotificationResult.outcome,
      })
      .from(pushNotificationResult)
      .where(eq(pushNotificationResult.candidateId, candidateId));
    expect([
      results.map((r) => [r.id, r.outcome]).sort(),
      await pushEvents(),
      await readStalePushClaims(db, candidateId),
    ]).toEqual([
      covered.map((c) => [c.notificationId, "failed"]).sort(),
      [
        {
          aggregate: `candidate:${candidateId}`,
          type: "push.not_delivered",
          reason: "Couldn't deliver a notification about more requests waiting for your approval",
          payload: {
            notificationId: covered[0]?.notificationId,
            requests: 3,
            sent: 0,
            gone: 1,
            rejected: 0,
          },
        },
      ],
      [],
    ]);
  });
});
