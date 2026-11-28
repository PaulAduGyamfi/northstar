import { z } from "zod";
import { apiFetch, isTimeout, TIMED_OUT_MESSAGE } from "./client-fetch";

// "Turn on notifications" on Today (NS-193 slice 2, ADR-0032): registers the service worker
// (public/sw.js), asks the browser's permission, subscribes with the API's VAPID public key and
// stores the subscription through the API (session only). The browser pieces are passed in, so
// tests need no browser. A push only shows fixed words and opens Today; it never acts.

export type PushBrowser = {
  // navigator.serviceWorker, or null where the browser has none.
  serviceWorker: Pick<ServiceWorkerContainer, "register" | "getRegistration"> | null;
  // Notification.requestPermission, or null where the browser has no notifications.
  requestPermission: (() => Promise<NotificationPermission>) | null;
  fetch?: typeof fetch;
};

export type PushOutcome = { ok: true; message: string } | { ok: false; message: string };

export const SW_PATH = "/sw.js";

const KeyBody = z.object({
  publicKey: z.string().nullable(),
  subscriptions: z.number().nullable(),
});
export type PushKey = z.infer<typeof KeyBody>;

// The VAPID key as the bytes pushManager.subscribe wants.
export function keyBytes(b64u: string): Uint8Array<ArrayBuffer> {
  const base64 = b64u.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const supported = (b: PushBrowser): boolean =>
  b.serviceWorker !== null && b.requestPermission !== null;

// What Today says about notifications, from GET /push/key.
export function pushStatusLine(key: PushKey | null): string {
  if (key === null) return "Couldn't check notifications.";
  if (key.publicKey === null) {
    return "Notifications aren't set up: add the PUSH_VAPID_* keys to .env.app and restart the API.";
  }
  if (key.subscriptions === null) return "Couldn't count the browsers with notifications on.";
  if (key.subscriptions === 0) return "Notifications are off in every browser.";
  return key.subscriptions === 1
    ? "Notifications are on in 1 browser."
    : `Notifications are on in ${key.subscriptions} browsers.`;
}

export async function readPushKey(fetchFn: typeof fetch = fetch): Promise<PushKey | null> {
  try {
    const res = await apiFetch("/api/push/key", {}, fetchFn);
    if (!res.ok) return null;
    const parsed = KeyBody.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const ERRORS: Record<string, string> = {
  push_not_set_up:
    "Notifications aren't set up: add the PUSH_VAPID_* keys to .env.app and restart the API.",
  endpoint_not_allowed: "This browser's push service isn't one Northstar sends to.",
};

async function post(
  path: string,
  body: unknown,
  fetchFn: typeof fetch,
): Promise<PushOutcome | null> {
  try {
    const res = await apiFetch(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      fetchFn,
    );
    if (res.ok) return null;
    const error = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, message: ERRORS[error.error ?? ""] ?? "Couldn't save that. Try again." };
  } catch (error) {
    return {
      ok: false,
      message: isTimeout(error) ? TIMED_OUT_MESSAGE : "Couldn't reach Northstar.",
    };
  }
}

// Turns notifications on in this browser.
export async function enablePush(b: PushBrowser): Promise<PushOutcome> {
  const fetchFn = b.fetch ?? fetch;
  if (b.serviceWorker === null || b.requestPermission === null) {
    return { ok: false, message: "This browser can't show notifications." };
  }
  const key = await readPushKey(fetchFn);
  if (key === null) return { ok: false, message: "Couldn't reach Northstar." };
  if (key.publicKey === null) return { ok: false, message: ERRORS.push_not_set_up as string };
  const permission = await b.requestPermission();
  if (permission !== "granted") {
    return {
      ok: false,
      message: "Notifications are blocked for Northstar in this browser's settings.",
    };
  }
  let subscription: PushSubscription;
  try {
    const registration = await b.serviceWorker.register(SW_PATH, { scope: "/" });
    subscription = await registration.pushManager.subscribe({
      // Every push shows a notification (the service worker's fixed words).
      userVisibleOnly: true,
      applicationServerKey: keyBytes(key.publicKey),
    });
  } catch {
    return { ok: false, message: "This browser couldn't subscribe. Try again." };
  }
  const json = subscription.toJSON();
  const failed = await post(
    "/api/push/subscribe",
    { endpoint: json.endpoint, keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth } },
    fetchFn,
  );
  if (failed) {
    // Not stored, so not kept: nothing would ever push to it.
    await subscription.unsubscribe().catch(() => false);
    return failed;
  }
  return { ok: true, message: "Notifications are on in this browser." };
}

// Turns notifications off in this browser: the API forgets the subscription first, then the
// browser drops it.
export async function disablePush(b: PushBrowser): Promise<PushOutcome> {
  const fetchFn = b.fetch ?? fetch;
  const registration = await b.serviceWorker?.getRegistration(SW_PATH).catch(() => undefined);
  const subscription = await registration?.pushManager.getSubscription().catch(() => null);
  if (!subscription) return { ok: true, message: "Notifications are already off in this browser." };
  const failed = await post("/api/push/unsubscribe", { endpoint: subscription.endpoint }, fetchFn);
  if (failed) return failed;
  await subscription.unsubscribe().catch(() => false);
  return { ok: true, message: "Notifications are off in this browser." };
}
