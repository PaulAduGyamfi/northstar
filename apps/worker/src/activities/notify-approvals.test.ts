import { randomUUID } from "node:crypto";
import {
  type Db,
  decideApprovals,
  type LivePushSubscription,
  listOpenDeadLetters,
  MAX_APPROVAL_PUSHES_PER_PASS,
  readEventsAfter,
  requestApproval,
  setKillSwitch,
  subscribePush,
} from "@northstar/db";
import { createTestDb, seedApplication, setGateClock } from "@northstar/db/testing";
import { CandidateId, type PushPayload } from "@northstar/domain";
import { PushError, PushHeldBack, type PushResult } from "@northstar/gateways";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbNotifyPorts } from "../notify-ports.js";
import { type NotifyPorts, notifyPass } from "./notify.js";

// The notifier's approval step (NS-204 slice 2) on the real write paths (PGlite), with the push
// service faked: nothing leaves the process. Synthetic requests and invented keys only.

const NOW = new Date("2026-11-25T12:00:00Z");

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let clock: Date;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "awaiting_approval");
  candidateId = CandidateId.parse(seeded.candidateId);
  clock = NOW;
  await setGateClock(db, clock);
});
afterEach(() => close());

// A synthetic reply request waiting for Paul, a second after the one before, so they keep order.
async function waiting(): Promise<string> {
  clock = new Date(clock.getTime() + 1000);
  await setGateClock(db, clock);
  const r = await requestApproval(db, {
    candidateId,
    kind: "email_reply",
    subject: `application:${randomUUID()}`,
    contentSha256: "a".repeat(64),
    facts: null,
    actor: "agent:inbox",
    idempotencyKey: randomUUID(),
  });
  if (!r.ok) throw new Error(r.error.kind);
  return r.value.requestId;
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
    .filter((e) => e.type === "push.sent" || e.type === "push.not_delivered")
    .map((e) => [e.type, e.aggregate]);

const letters = async () =>
  (await listOpenDeadLetters(db, candidateId))
    .filter((l) => l.kind === "push.notify")
    .map((l) => [l.reasonCode, l.subject]);

const payloads = (sent: Sent[]) => sent.map((s) => s.payload);

describe("notifyPass for requests waiting in the Queue (NS-204 slice 2)", () => {
  it("pushes a waiting request once to each browser, by its id and kind only, even when the pass runs twice", async () => {
    const requestId = await waiting();
    await subscribe("device-1");
    await subscribe("device-2");
    const { ports: p, sent } = ports();
    const first = await notifyPass(p, candidateId);
    const second = await notifyPass(p, candidateId);
    const payload = { v: 1, kind: "approval", id: requestId, request: "email_reply" };
    expect([first.notified, second.notified, payloads(sent), await pushEvents()]).toEqual([
      1,
      0,
      [payload, payload],
      [["push.sent", `approval:${requestId}`]],
    ]);
  });

  it("pushes the first five alone and the rest in one overflow push, then nothing more", async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_APPROVAL_PUSHES_PER_PASS + 3; i++) ids.push(await waiting());
    await subscribe();
    const { ports: p, sent } = ports();
    await notifyPass(p, candidateId);
    await notifyPass(p, candidateId);
    expect([payloads(sent), await pushEvents()]).toEqual([
      [
        ...ids
          .slice(0, MAX_APPROVAL_PUSHES_PER_PASS)
          .map((id) => ({ v: 1, kind: "approval", id, request: "email_reply" })),
        { v: 1, kind: "approvals_waiting", more: 3 },
      ],
      [
        ...ids.slice(0, MAX_APPROVAL_PUSHES_PER_PASS).map((id) => ["push.sent", `approval:${id}`]),
        ["push.sent", `candidate:${candidateId}`],
      ],
    ]);
  });

  it("never pushes a request Paul already decided", async () => {
    const requestId = await waiting();
    await decideApprovals(db, { candidateId, requestIds: [requestId], decision: "approve" });
    await subscribe();
    const { ports: p, sent } = ports();
    await notifyPass(p, candidateId);
    expect(sent).toEqual([]);
  });

  it("claims nothing while push is switched off, then pushes once it is back on", async () => {
    await waiting();
    await subscribe();
    await setKillSwitch(db, {
      candidateId,
      subsystem: "push",
      enabled: false,
      actor: "user",
      reason: "Testing quiet",
    });
    const { ports: p, sent } = ports();
    const off = await notifyPass(p, candidateId);
    await setKillSwitch(db, {
      candidateId,
      subsystem: "push",
      enabled: true,
      actor: "user",
      reason: "Back on",
    });
    await notifyPass(p, candidateId);
    expect([off.idle, sent.length]).toEqual(["switched_off", 1]);
  });

  it("stops once the breaker holds a request's every push back, so the rest wait unclaimed", async () => {
    await waiting();
    await waiting();
    await subscribe();
    const held = ports(new PushHeldBack("breaker", null));
    await notifyPass(held.ports, candidateId);
    const working = ports();
    await notifyPass(working.ports, candidateId);
    expect([
      held.sent.length,
      (await letters()).map(([code]) => code),
      working.sent.length,
    ]).toEqual([1, ["push_paused"], 1]);
  });

  it("turns an overflow push no browser took into one not_delivered letter, never sent again", async () => {
    for (let i = 0; i < MAX_APPROVAL_PUSHES_PER_PASS + 2; i++) await waiting();
    await subscribe();
    // The pushes of their own go out; only the overflow push fails.
    const sent: Sent[] = [];
    const base = ports().ports;
    const p: NotifyPorts = {
      ...base,
      send: async (_c, subscription, payload) => {
        sent.push({ endpoint: subscription.endpoint, payload });
        if (payload.kind === "approvals_waiting") throw new PushError("answered 503", 503);
        return "sent";
      },
    };
    await notifyPass(p, candidateId);
    await notifyPass(p, candidateId);
    expect([
      sent.filter((s) => s.payload.kind === "approvals_waiting").length,
      await letters(),
      (await pushEvents()).at(-1),
    ]).toEqual([
      1,
      [["not_delivered", `candidate:${candidateId}`]],
      ["push.not_delivered", `candidate:${candidateId}`],
    ]);
  });

  it("reports a request's claim left without a result as outcome_unknown on the request, once", async () => {
    const requestId = await waiting();
    await subscribe();
    const { ports: p, sent } = ports();
    await p.claimApproval(candidateId, requestId);
    // Twenty minutes past the real clock (claims are stamped by now()): past the 15-minute lease.
    await setGateClock(db, new Date(Date.now() + 20 * 60_000));
    await notifyPass(p, candidateId);
    await notifyPass(p, candidateId);
    expect([await letters(), sent]).toEqual([[["outcome_unknown", `approval:${requestId}`]], []]);
  });
});
