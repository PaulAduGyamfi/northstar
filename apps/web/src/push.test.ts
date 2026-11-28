import { describe, expect, it } from "vitest";
import { disablePush, enablePush, type PushBrowser, pushStatusLine, vapidKeyBytes } from "./push";

// "Turn on notifications" (NS-193 slice 2) with the browser and API faked. Synthetic keys only.

const PUBLIC_KEY = `B${"A".repeat(86)}`;
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/device-1";

type Call = { url: string; body?: unknown };

function fakeFetch(answers: Record<string, { status: number; body: unknown }>, calls: Call[]) {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const a = answers[url] ?? { status: 404, body: {} };
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as typeof fetch;
}

function fakeSubscription(log: string[]) {
  return {
    endpoint: ENDPOINT,
    toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: async () => {
      log.push("unsubscribe");
      return true;
    },
  } as unknown as PushSubscription;
}

function fakeBrowser(
  log: string[],
  over: { permission?: NotificationPermission; existing?: boolean } = {},
): Omit<PushBrowser, "fetch"> {
  const sub = fakeSubscription(log);
  const registration = {
    pushManager: {
      subscribe: async (options: PushSubscriptionOptionsInit) => {
        log.push(`subscribe:${options.userVisibleOnly}`);
        return sub;
      },
      getSubscription: async () => (over.existing === false ? null : sub),
    },
  } as unknown as ServiceWorkerRegistration;
  return {
    serviceWorker: {
      register: async (path: string | URL) => {
        log.push(`register:${String(path)}`);
        return registration;
      },
      getRegistration: async () => registration,
    } as unknown as PushBrowser["serviceWorker"],
    requestPermission: async () => over.permission ?? "granted",
  };
}

const keyAnswer = (publicKey: string | null) => ({
  "/api/push/key": { status: 200, body: { publicKey, subscriptions: 0 } },
});

describe("enablePush (NS-193 slice 2)", () => {
  it("registers the service worker, subscribes with the VAPID key and stores the subscription", async () => {
    const log: string[] = [];
    const calls: Call[] = [];
    const fetch = fakeFetch(
      { ...keyAnswer(PUBLIC_KEY), "/api/push/subscribe": { status: 200, body: { created: true } } },
      calls,
    );
    const outcome = await enablePush({ ...fakeBrowser(log), fetch });
    expect(outcome).toEqual({ ok: true, message: "Notifications are on in this browser." });
    expect(log).toEqual(["register:/sw.js", "subscribe:true"]);
    expect(calls[1]).toEqual({
      url: "/api/push/subscribe",
      body: { endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } },
    });
  });

  it("says push isn't set up and asks nothing of the browser when there is no key", async () => {
    const log: string[] = [];
    const outcome = await enablePush({
      ...fakeBrowser(log),
      fetch: fakeFetch(keyAnswer(null), []),
    });
    expect([outcome.ok, log]).toEqual([false, []]);
  });

  it("stops when Paul blocks notifications", async () => {
    const log: string[] = [];
    const outcome = await enablePush({
      ...fakeBrowser(log, { permission: "denied" }),
      fetch: fakeFetch(keyAnswer(PUBLIC_KEY), []),
    });
    expect(outcome).toEqual({
      ok: false,
      message: "Notifications are blocked for Northstar in this browser's settings.",
    });
    expect(log).toEqual([]);
  });

  it("drops the browser's subscription again when the API won't store it", async () => {
    const log: string[] = [];
    const fetch = fakeFetch(
      {
        ...keyAnswer(PUBLIC_KEY),
        "/api/push/subscribe": { status: 400, body: { error: "endpoint_not_allowed" } },
      },
      [],
    );
    const outcome = await enablePush({ ...fakeBrowser(log), fetch });
    expect(outcome).toEqual({
      ok: false,
      message: "This browser's push service isn't one Northstar sends to.",
    });
    expect(log).toEqual(["register:/sw.js", "subscribe:true", "unsubscribe"]);
  });
});

describe("disablePush (NS-193 slice 2)", () => {
  it("has the API forget the subscription, then drops it in the browser", async () => {
    const log: string[] = [];
    const calls: Call[] = [];
    const fetch = fakeFetch(
      { "/api/push/unsubscribe": { status: 200, body: { removed: true } } },
      calls,
    );
    const outcome = await disablePush({ ...fakeBrowser(log), fetch });
    expect([outcome.ok, calls, log]).toEqual([
      true,
      [{ url: "/api/push/unsubscribe", body: { endpoint: ENDPOINT } }],
      ["unsubscribe"],
    ]);
  });

  it("keeps the browser's subscription when the API couldn't forget it", async () => {
    const log: string[] = [];
    const fetch = fakeFetch({ "/api/push/unsubscribe": { status: 503, body: {} } }, []);
    const outcome = await disablePush({ ...fakeBrowser(log), fetch });
    expect([outcome.ok, log]).toEqual([false, []]);
  });
});

describe("pushStatusLine (NS-193 slice 2)", () => {
  it("words each state, and an unknown count is never 0", () => {
    expect([
      pushStatusLine(null),
      pushStatusLine({ publicKey: null, subscriptions: 0 }),
      pushStatusLine({ publicKey: PUBLIC_KEY, subscriptions: null }),
      pushStatusLine({ publicKey: PUBLIC_KEY, subscriptions: 0 }),
      pushStatusLine({ publicKey: PUBLIC_KEY, subscriptions: 1 }),
      pushStatusLine({ publicKey: PUBLIC_KEY, subscriptions: 3 }),
    ]).toEqual([
      "Couldn't check notifications.",
      "Notifications aren't set up: add the PUSH_VAPID_* keys to .env.app and restart the API.",
      "Couldn't count the browsers with notifications on.",
      "Notifications are off in every browser.",
      "Notifications are on in 1 browser.",
      "Notifications are on in 3 browsers.",
    ]);
  });
});

describe("vapidKeyBytes", () => {
  it("decodes the base64url key into its 65 bytes", () => {
    const bytes = vapidKeyBytes(PUBLIC_KEY);
    expect([bytes.length, bytes[0]]).toEqual([65, 4]);
  });
});
