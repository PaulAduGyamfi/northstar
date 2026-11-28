import { randomUUID } from "node:crypto";
import {
  claimSubmission,
  type Db,
  decideApprovals,
  type LivePushSubscription,
  listOpenDeadLetters,
  listOpenHandoffs,
  readEventsAfter,
  readLivePushSubscriptions,
  recordNeedsHuman,
  requestApproval,
  resolveHandoff,
  schema,
  setKillSwitch,
  subscribePush,
} from "@northstar/db";
import { createTestDb, seedApplication } from "@northstar/db/testing";
import { CandidateId, type PushPayload } from "@northstar/domain";
import { PushError, PushHeldBack, type PushResult } from "@northstar/gateways";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbNotifyPorts } from "../notify-ports.js";
import { type NotifyPorts, notifyPass } from "./notify.js";

// The handoff notifier (NS-193 slice 3) on the real write paths (PGlite), with the push service
// faked: nothing leaves the process. Synthetic jobs, example.com links and invented keys only.

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
afterEach(() => close());

// An open handoff: a CAPTCHA stopped a claimed Greenhouse submission. Its id.
async function openHandoff(): Promise<string> {
  const [j] = await db
    .insert(schema.job)
    .values({
      candidateId,
      companyId,
      title: "Engineer",
      url: `https://jobs.example.com/${randomUUID()}`,
    })
    .returning();
  if (!j) throw new Error("no job");
  const [a] = await db
    .insert(schema.application)
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
  const submissionId = claimed.value.submission.submissionId;
  await recordNeedsHuman(db, candidateId, submissionId, "captcha", APPLY_URL);
  const h = (await listOpenHandoffs(db, candidateId)).find((o) => o.submissionId === submissionId);
  if (!h) throw new Error("no handoff");
  return h.handoffId;
}

// A browser that turned notifications on (an invented key, never a real device's).
const subscribe = (device = "device-1") =>
  subscribePush(db, candidateId, {
    endpoint: `https://fcm.googleapis.com/fcm/send/${device}`,
    p256dh: `B${"A".repeat(86)}`,
    auth: "A".repeat(22),
  });

type Sent = { endpoint: string; payload: PushPayload };

// The real ports with the push service faked: each push is recorded and answered `answer`.
function ports(answer: PushResult | Error = "sent"): { ports: NotifyPorts; sent: Sent[] } {
  const sent: Sent[] = [];
  const base = dbNotifyPorts(db, null);
  return {
    sent,
    ports: {
      ...base,
      send: async (_candidate, subscription: LivePushSubscription, payload: PushPayload) => {
        sent.push({ endpoint: subscription.endpoint, payload });
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

const pushEvents = async () =>
  (await readEventsAfter(db, candidateId, 0n, 500))
    .map((e) => e.event)
    .filter(
      (e) =>
        e.type.startsWith("push.") &&
        e.type !== "push.subscribed" &&
        e.type !== "push.unsubscribed",
    )
    .map((e) => e.type);

const letters = async () =>
  (await listOpenDeadLetters(db, candidateId))
    .filter((l) => l.kind === "push.notify")
    .map((l) => l.reasonCode);

describe("notifyPass (NS-193 slice 3)", () => {
  it("sends one notification per handoff to each browser, even when the sender runs twice", async () => {
    const handoffId = await openHandoff();
    await subscribe("device-1");
    await subscribe("device-2");
    const { ports: p, sent } = ports();
    const first = await notifyPass(p, candidateId);
    const second = await notifyPass(p, candidateId);
    expect([first.notified, second.notified]).toEqual([1, 0]);
    expect(sent.map((s) => s.endpoint)).toEqual([
      "https://fcm.googleapis.com/fcm/send/device-1",
      "https://fcm.googleapis.com/fcm/send/device-2",
    ]);
    expect(sent[0]?.payload).toEqual({
      v: 1,
      kind: "handoff",
      id: handoffId,
      ats: "greenhouse",
      reason: "captcha",
    });
    expect(await pushEvents()).toEqual(["push.sent"]);
  });

  it("sends nothing for a handoff Paul resolved before the sender ran", async () => {
    const handoffId = await openHandoff();
    await subscribe();
    await resolveHandoff(db, { candidateId, handoffId, outcome: "submitted" });
    const { ports: p, sent } = ports();
    await notifyPass(p, candidateId);
    expect([sent, await pushEvents()]).toEqual([[], []]);
  });

  it("never puts the apply URL, company or job title in what it sends", async () => {
    await openHandoff();
    await subscribe();
    const { ports: p, sent } = ports();
    await notifyPass(p, candidateId);
    const text = JSON.stringify(sent.map((s) => s.payload));
    expect(text).not.toContain("greenhouse.io");
    expect(text).not.toContain("Engineer");
    // The seeded company's name.
    expect(text).not.toContain("Example Corp");
    expect(text).not.toContain("https://");
  });

  it("claims nothing while no browser has notifications on, and sends once one does", async () => {
    await openHandoff();
    const { ports: p, sent } = ports();
    expect((await notifyPass(p, candidateId)).idle).toBe("no_browsers");
    await subscribe();
    await notifyPass(p, candidateId);
    expect(sent).toHaveLength(1);
  });

  it("claims nothing while the push kill switch is off", async () => {
    await openHandoff();
    await subscribe();
    await setKillSwitch(db, {
      candidateId,
      subsystem: "push",
      enabled: false,
      actor: "user",
      reason: "Quiet for a while",
    });
    const { ports: p, sent } = ports();
    expect([(await notifyPass(p, candidateId)).idle, sent]).toEqual(["switched_off", []]);
  });

  it("does nothing at all while push isn't set up", async () => {
    await openHandoff();
    await subscribe();
    expect(await notifyPass(dbNotifyPorts(db, null), candidateId)).toEqual({
      notified: 0,
      undelivered: 0,
      unknown: 0,
      idle: "off",
    });
  });

  it("turns a push no browser took into a not_delivered dead letter, and never sends it again", async () => {
    await openHandoff();
    await subscribe();
    const failing = ports(new PushError("push service answered 503", 503));
    await notifyPass(failing.ports, candidateId);
    const working = ports();
    await notifyPass(working.ports, candidateId);
    expect([await pushEvents(), await letters(), working.sent]).toEqual([
      ["push.not_delivered"],
      ["not_delivered"],
      [],
    ]);
  });

  it("stops claiming once the breaker holds a handoff's every push back, so the rest wait", async () => {
    await openHandoff();
    await openHandoff();
    await subscribe();
    const held = ports(new PushHeldBack("breaker", null));
    await notifyPass(held.ports, candidateId);
    // One handoff used its push and is reported apart; the other is still waiting, unclaimed.
    expect([await letters(), held.sent.length]).toEqual([["push_paused"], 1]);
    const working = ports();
    await notifyPass(working.ports, candidateId);
    expect(working.sent).toHaveLength(1);
  });

  it("drops a browser the push service says is gone", async () => {
    await openHandoff();
    await subscribe();
    await notifyPass(ports("gone").ports, candidateId);
    expect(await readLivePushSubscriptions(db, candidateId)).toEqual([]);
  });

  it("reports a claim left without a result as outcome_unknown, once, and sends nothing", async () => {
    const handoffId = await openHandoff();
    await subscribe();
    // A run that died after its claim: the claim is taken, no push recorded.
    const { ports: p, sent } = ports();
    await p.claim(candidateId, handoffId);
    // Twenty minutes later by the Gate's clock: past the 15-minute lease.
    await db.execute(
      sql`select set_config('northstar.gate_test_now', ${new Date(Date.now() + 20 * 60_000).toISOString()}, false)`,
    );
    await notifyPass(p, candidateId);
    await notifyPass(p, candidateId);
    expect([await letters(), sent]).toEqual([["outcome_unknown"], []]);
  });
});
