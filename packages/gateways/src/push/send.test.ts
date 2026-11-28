import { createECDH, generateKeyPairSync } from "node:crypto";
import type { CallDecision, CallOutcome, PushPayload } from "@northstar/domain";
import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPushSender,
  PushError,
  type PushGuard,
  PushHeldBack,
  PushRequestError,
  type PushSubscriptionKeys,
} from "./send.js";
import { loadVapidConfig } from "./vapid.js";

const span = trace.getTracer("test").startSpan("test");

// Keys made for the test run: never real ones.
function vapid() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  const pub = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x ?? "", "base64url"),
    Buffer.from(jwk.y ?? "", "base64url"),
  ]);
  const config = loadVapidConfig({
    PUSH_VAPID_PUBLIC_KEY: pub.toString("base64url"),
    PUSH_VAPID_PRIVATE_KEY: jwk.d,
    PUSH_VAPID_SUBJECT: "mailto:push@example.com",
  });
  if (!config) throw new Error("no config");
  return config;
}

function subscription(
  endpoint = "https://fcm.googleapis.com/fcm/send/device-1",
): PushSubscriptionKeys {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  return {
    endpoint,
    p256dh: ua.getPublicKey().toString("base64url"),
    auth: Buffer.alloc(16, 7).toString("base64url"),
  };
}

const payload: PushPayload = {
  v: 1,
  kind: "handoff",
  id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
  ats: "lever",
  reason: "login",
};

function guard(over: { on?: boolean; decision?: CallDecision; throws?: boolean } = {}) {
  const reports: CallOutcome[] = [];
  const g: PushGuard = {
    isOn: async () => {
      if (over.throws) throw new Error("database down");
      return over.on ?? true;
    },
    acquire: async () => over.decision ?? { allowed: true, probe: false },
    report: async (_d, outcome) => {
      reports.push(outcome);
    },
  };
  return { g, reports };
}

type Call = { url: string; init: RequestInit };
function stubFetch(answer: number | Error) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
    calls.push({ url: url.href, init });
    if (answer instanceof Error) throw answer;
    return new Response(null, { status: answer });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const sender = (g: PushGuard) =>
  createPushSender({ vapid: vapid(), guard: g, now: () => new Date("2026-11-28T12:00:00Z") });

describe("createPushSender (NS-193, ADR-0032 item 3)", () => {
  it("posts one encrypted push with VAPID, aes128gcm, a TTL and high urgency", async () => {
    const calls = stubFetch(201);
    const { g, reports } = guard();
    expect(await sender(g).send(subscription(), payload, span)).toBe("sent");
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.url).toBe("https://fcm.googleapis.com/fcm/send/device-1");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["content-encoding"]).toBe("aes128gcm");
    expect(headers.ttl).toBe("86400");
    expect(headers.urgency).toBe("high");
    expect(headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(call.init.redirect).toBe("error");
    expect(reports).toEqual([{ ok: true }]);
  });

  it("never puts the payload's words or ids on the wire in the clear", async () => {
    const calls = stubFetch(201);
    await sender(guard().g).send(subscription(), payload, span);
    const body = Buffer.from((calls[0] as Call).init.body as Uint8Array).toString("latin1");
    expect(body).not.toContain(payload.id);
    expect(body).not.toContain("lever");
  });

  it("answers gone for 404 and 410, so the caller drops the subscription", async () => {
    for (const status of [404, 410]) {
      stubFetch(status);
      const { g, reports } = guard();
      expect(await sender(g).send(subscription(), payload, span)).toBe("gone");
      expect(reports).toEqual([{ ok: true }]);
    }
  });

  it("answers rejected for another 4xx, which doesn't count against the breaker", async () => {
    stubFetch(413);
    const { g, reports } = guard();
    expect(await sender(g).send(subscription(), payload, span)).toBe("rejected");
    expect(reports).toEqual([{ ok: true }]);
  });

  it("throws PushError for 429 and 5xx and reports each as a fault", async () => {
    for (const status of [429, 503]) {
      stubFetch(status);
      const { g, reports } = guard();
      const error = await sender(g)
        .send(subscription(), payload, span)
        .catch((e) => e);
      expect([error instanceof PushError, error.status]).toEqual([true, status]);
      expect(reports).toEqual([{ ok: false, error: "PushError" }]);
    }
  });

  it("throws PushError with status 0 when the push service doesn't answer", async () => {
    stubFetch(new TypeError("fetch failed"));
    const { g, reports } = guard();
    const error = await sender(g)
      .send(subscription(), payload, span)
      .catch((e) => e);
    expect([error instanceof PushError, error.status]).toEqual([true, 0]);
    expect(reports).toEqual([{ ok: false, error: "PushError" }]);
  });

  it("sends nothing while the push kill switch is off", async () => {
    const calls = stubFetch(201);
    const error = await sender(guard({ on: false }).g)
      .send(subscription(), payload, span)
      .catch((e) => e);
    expect([error instanceof PushHeldBack, error.by, calls.length]).toEqual([
      true,
      "kill_switch",
      0,
    ]);
  });

  it("sends nothing while the push breaker is open, and says when to retry", async () => {
    const calls = stubFetch(201);
    const retryAt = new Date("2026-11-28T12:01:00Z");
    const { g } = guard({ decision: { allowed: false, retryAt, lastError: "PushError" } });
    const error = await sender(g)
      .send(subscription(), payload, span)
      .catch((e) => e);
    expect([error.by, error.retryAt, calls.length]).toEqual(["breaker", retryAt, 0]);
  });

  it("holds the push back when the guard itself fails", async () => {
    const calls = stubFetch(201);
    const error = await sender(guard({ throws: true }).g)
      .send(subscription(), payload, span)
      .catch((e) => e);
    expect([error instanceof PushHeldBack, error.by, calls.length]).toEqual([
      true,
      "guard_error",
      0,
    ]);
  });

  it("refuses an endpoint outside the allowlist before asking the guard or calling anything", async () => {
    const calls = stubFetch(201);
    const { g, reports } = guard();
    const error = await sender(g)
      .send(subscription("https://169.254.169.254/latest/meta-data"), payload, span)
      .catch((e) => e);
    expect([error instanceof PushRequestError, calls.length, reports.length]).toEqual([true, 0, 0]);
  });

  it("refuses a payload that isn't a push payload", async () => {
    const calls = stubFetch(201);
    const bad = { ...payload, url: "https://example.com" } as unknown as PushPayload;
    const error = await sender(guard().g)
      .send(subscription(), bad, span)
      .catch((e) => e);
    expect([error.message, calls.length]).toEqual(["payload is not a push payload", 0]);
  });

  it("refuses subscription keys that aren't valid, without naming them", async () => {
    const calls = stubFetch(201);
    const offCurve = Buffer.alloc(65, 1);
    offCurve[0] = 4;
    const sub = { ...subscription(), p256dh: offCurve.toString("base64url") };
    const error = await sender(guard().g)
      .send(sub, payload, span)
      .catch((e) => e);
    expect([error instanceof PushRequestError, error.message, calls.length]).toEqual([
      true,
      "p256dh is not a valid P-256 point",
      0,
    ]);
  });
});
