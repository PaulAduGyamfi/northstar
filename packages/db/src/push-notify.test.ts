import { randomUUID } from "node:crypto";
import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimSubmission, recordNeedsHuman } from "./apply-write.js";
import { decideApprovals, requestApproval } from "./approval-write.js";
import type { Db } from "./db.js";
import { listOpenHandoffs, resolveHandoff } from "./handoff-write.js";
import {
  claimHandoffNotification,
  handoffNotifyKey,
  readHandoffsToNotify,
  readStalePushClaims,
  recordPushResult,
} from "./push-notify-write.js";
import { pushNotification } from "./push-schema.js";
import { application, domainEvent, job } from "./schema.js";
import { createTestDb, seedApplication } from "./test/pglite.js";

// The handoff notifier's records (NS-193 slice 3) on the real write paths, PGlite. Synthetic jobs
// and example.com links only.

const NOW = new Date("2026-11-25T12:00:00Z");
const APPLY_URL = "https://boards.greenhouse.io/globex/jobs/123";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let companyId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "awaiting_approval");
  candidateId = CandidateId.parse(seeded.candidateId);
  companyId = seeded.companyId;
  await db.execute(sql`select set_config('northstar.gate_test_now', ${NOW.toISOString()}, false)`);
});

afterEach(async () => {
  await close();
});

// A claimed, in-progress submission for a synthetic approved application.
async function inProgress(): Promise<{ submissionId: string; applicationId: string }> {
  const [j] = await db
    .insert(job)
    .values({
      candidateId,
      companyId,
      title: "Engineer",
      url: `https://jobs.example.com/${randomUUID()}`,
    })
    .returning();
  if (!j) throw new Error("no job");
  const [a] = await db
    .insert(application)
    .values({ candidateId, jobId: j.id, status: "awaiting_approval" })
    .returning();
  if (!a) throw new Error("no application");
  const requested = await requestApproval(db, {
    candidateId,
    kind: "application_package",
    subject: `application_package:${randomUUID()}`,
    contentSha256: "c".repeat(64),
    facts: null,
    actor: "agent:apply",
    idempotencyKey: randomUUID(),
  });
  if (!requested.ok) throw new Error(requested.error.kind);
  const decided = await decideApprovals(db, {
    candidateId,
    requestIds: [requested.value.requestId],
    decision: "approve",
  });
  const outcome = decided.ok ? decided.value[0]?.result : undefined;
  if (!outcome?.ok) throw new Error("not approved");
  const claimed = await claimSubmission(db, {
    candidateId,
    applicationId: a.id,
    decisionId: outcome.value.decisionId,
    ats: "greenhouse",
    postingId: randomUUID(),
  });
  if (!claimed.ok || !("claimed" in claimed.value)) throw new Error("not claimed");
  return { submissionId: claimed.value.submission.submissionId, applicationId: a.id };
}

// An open handoff (a CAPTCHA stopped a Greenhouse form); its id.
async function openHandoff(): Promise<string> {
  const { submissionId } = await inProgress();
  const r = await recordNeedsHuman(db, candidateId, submissionId, "captcha", APPLY_URL);
  if (!r.ok) throw new Error("needs_human not recorded");
  const open = await listOpenHandoffs(db, candidateId);
  const h = open.find((o) => o.submissionId === submissionId);
  if (!h) throw new Error("no handoff");
  return h.handoffId;
}

describe("readHandoffsToNotify (NS-193 slice 3)", () => {
  it("lists an open handoff with its ATS and challenge, and nothing else about it", async () => {
    const handoffId = await openHandoff();
    expect(await readHandoffsToNotify(db, candidateId)).toEqual([
      { handoffId, ats: "greenhouse", reason: "captcha" },
    ]);
  });

  it("leaves out a handoff Paul resolved", async () => {
    const handoffId = await openHandoff();
    await resolveHandoff(db, { candidateId, handoffId, outcome: "submitted" });
    expect(await readHandoffsToNotify(db, candidateId)).toEqual([]);
  });

  it("leaves out a handoff already claimed", async () => {
    const handoffId = await openHandoff();
    await claimHandoffNotification(db, candidateId, handoffId);
    expect(await readHandoffsToNotify(db, candidateId)).toEqual([]);
  });
});

describe("claimHandoffNotification (NS-193 slice 3)", () => {
  it("claims a handoff once, however many times it is asked", async () => {
    const handoffId = await openHandoff();
    const first = await claimHandoffNotification(db, candidateId, handoffId);
    const second = await claimHandoffNotification(db, candidateId, handoffId);
    expect([first.kind, second.kind]).toEqual(["claimed", "already_claimed"]);
    const claims = await db
      .select({ itemKey: pushNotification.itemKey })
      .from(pushNotification)
      .where(eq(pushNotification.candidateId, candidateId));
    expect(claims).toEqual([{ itemKey: handoffNotifyKey(handoffId) }]);
  });

  it("claims nothing for a handoff Paul resolved", async () => {
    const handoffId = await openHandoff();
    await resolveHandoff(db, { candidateId, handoffId, outcome: "gave_up" });
    expect(await claimHandoffNotification(db, candidateId, handoffId)).toEqual({
      kind: "resolved",
    });
  });

  it("claims nothing for a handoff that isn't the candidate's", async () => {
    const handoffId = await openHandoff();
    const other = CandidateId.parse((await seedApplication(db, "queued")).candidateId);
    expect(await claimHandoffNotification(db, other, handoffId)).toEqual({ kind: "not_found" });
  });
});

describe("recordPushResult (NS-193 slice 3)", () => {
  async function claimed(): Promise<{ handoffId: string; notificationId: string }> {
    const handoffId = await openHandoff();
    const c = await claimHandoffNotification(db, candidateId, handoffId);
    if (c.kind !== "claimed") throw new Error("not claimed");
    return { handoffId, notificationId: c.notificationId };
  }

  it("records a sent push once, with a fixed-word feed line and counts only", async () => {
    const { handoffId, notificationId } = await claimed();
    const input = { candidateId, notificationId, handoffId, sent: 1, gone: 1, rejected: 0 };
    expect([await recordPushResult(db, input), await recordPushResult(db, input)]).toEqual([
      { recorded: true },
      { recorded: false },
    ]);
    const events = await db
      .select({ type: domainEvent.type, reason: domainEvent.reason, payload: domainEvent.payload })
      .from(domainEvent)
      .where(eq(domainEvent.aggregate, `apply_handoff:${handoffId}`));
    expect(events.filter((e) => e.type.startsWith("push."))).toEqual([
      {
        type: "push.sent",
        reason: "Sent you a notification: an application needs your hands",
        payload: { notificationId, sent: 1, gone: 1, rejected: 0 },
      },
    ]);
  });

  it("records a push no browser took as not delivered", async () => {
    const { handoffId, notificationId } = await claimed();
    await recordPushResult(db, {
      candidateId,
      notificationId,
      handoffId,
      sent: 0,
      gone: 0,
      rejected: 1,
    });
    const [event] = await db
      .select({ type: domainEvent.type })
      .from(domainEvent)
      .where(eq(domainEvent.type, "push.not_delivered"));
    expect(event).toEqual({ type: "push.not_delivered" });
  });
});

// Moves the Gate's clock to twenty minutes after the real one: claims are stamped by now().
const laterByTwentyMinutes = () =>
  db.execute(
    sql`select set_config('northstar.gate_test_now', ${new Date(Date.now() + 20 * 60_000).toISOString()}, false)`,
  );

describe("readStalePushClaims (NS-193 slice 3)", () => {
  it("lists a claim with no result once its lease has passed, and not before", async () => {
    const handoffId = await openHandoff();
    const c = await claimHandoffNotification(db, candidateId, handoffId);
    if (c.kind !== "claimed") throw new Error("not claimed");
    expect(await readStalePushClaims(db, candidateId)).toEqual([]);
    // Twenty minutes later by the Gate's clock: past the 15-minute lease.
    await laterByTwentyMinutes();
    expect(await readStalePushClaims(db, candidateId)).toEqual([
      { notificationId: c.notificationId, itemKey: handoffNotifyKey(handoffId) },
    ]);
  });

  it("never lists a claim whose result is recorded", async () => {
    const handoffId = await openHandoff();
    const c = await claimHandoffNotification(db, candidateId, handoffId);
    if (c.kind !== "claimed") throw new Error("not claimed");
    await recordPushResult(db, {
      candidateId,
      notificationId: c.notificationId,
      handoffId,
      sent: 1,
      gone: 0,
      rejected: 0,
    });
    await laterByTwentyMinutes();
    expect(await readStalePushClaims(db, candidateId)).toEqual([]);
  });
});
