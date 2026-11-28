import {
  type CallDecision,
  type CallOutcome,
  encodePushPayload,
  type PushPayload,
} from "@northstar/domain";
import type { Span } from "@opentelemetry/api";
import { encryptPayload, PushEncryptError } from "./encrypt.js";
import { allowedEndpoint } from "./endpoint.js";
import { type VapidConfig, vapidAuthorization } from "./vapid.js";

// The web push sender (NS-193, ADR-0032 item 3). It pushes to Paul's own browsers, never to
// anyone else, and acts on nothing: a push only shows fixed words and opens the app (item 7).
// Every push passes the endpoint allowlist, then the `push` kill switch and breaker at the moment
// it goes out (ADR-0007). It uses the global fetch, like the other gateways.

export const PUSH_SUBSYSTEM = "push";
export const PUSH_DEPENDENCY = "push";
const TIMEOUT_MS = 10_000;
// How long a push service keeps an undelivered push (seconds): a day, then it is dropped.
const TTL_SECONDS = 86_400;

// A browser's subscription as stored: its endpoint and keys in base64url.
export type PushSubscriptionKeys = { endpoint: string; p256dh: string; auth: string };

// The stored kill switch and breaker, asked when each push goes out.
export type PushGuard = {
  isOn: (subsystem: string) => Promise<boolean>;
  acquire: (dependency: string) => Promise<CallDecision>;
  report: (dependency: string, outcome: CallOutcome, probeToken: string | null) => Promise<void>;
};

// sent: the push service took it. gone: the subscription no longer exists (404, 410), so drop it.
// rejected: the push service refused it for another reason (a 4xx); not retried.
export type PushResult = "sent" | "gone" | "rejected";

// A push the guard held back: it never went out. Retryable.
export class PushHeldBack extends Error {
  override name = "PushHeldBack";
  constructor(
    readonly by: "kill_switch" | "breaker" | "guard_error",
    readonly retryAt: Date | null,
  ) {
    super(`push held back by ${by}`);
  }
}

// No answer, 429 or 5xx from the push service: retryable. The message names the status only.
export class PushError extends Error {
  override name = "PushError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// A subscription or payload the sender refuses before any request: a bug or a bad row, never
// retried. Names what was wrong, never the endpoint or a key.
export class PushRequestError extends Error {
  override name = "PushRequestError";
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const key = (name: string, value: string) => {
  if (!B64URL.test(value)) throw new PushRequestError(`${name} is not base64url`);
  return Buffer.from(value, "base64url");
};

export type PushSenderDeps = {
  vapid: VapidConfig;
  guard: PushGuard;
  now?: () => Date;
};

export type PushSender = {
  send: (
    subscription: PushSubscriptionKeys,
    payload: PushPayload,
    span: Span,
  ) => Promise<PushResult>;
};

export function createPushSender(deps: PushSenderDeps): PushSender {
  const now = deps.now ?? (() => new Date());
  return {
    async send(subscription, payload, span) {
      // Checked before anything else: no request to a host outside the allowlist.
      const endpoint = allowedEndpoint(subscription.endpoint);
      if (endpoint === null) throw new PushRequestError("endpoint outside the push allowlist");
      // The host only: the path identifies the device.
      span.setAttribute("push.host", endpoint.hostname);
      const json = encodePushPayload(payload);
      if (json === null) throw new PushRequestError("payload is not a push payload");
      let body: Buffer;
      try {
        body = encryptPayload(Buffer.from(json, "utf8"), {
          p256dh: key("p256dh", subscription.p256dh),
          auth: key("auth", subscription.auth),
        });
      } catch (error) {
        if (error instanceof PushEncryptError) throw new PushRequestError(error.message);
        throw error;
      }

      // Signed before the guard and the request: a local signing error is a bug, never a push
      // service fault, so it must not reach the breaker.
      let authorization: string;
      try {
        authorization = vapidAuthorization(deps.vapid, endpoint, now());
      } catch (error) {
        throw new PushRequestError(`couldn't sign the push (${(error as Error).name})`);
      }

      let probeToken: string | null;
      try {
        if (!(await deps.guard.isOn(PUSH_SUBSYSTEM))) throw new PushHeldBack("kill_switch", null);
        const decision = await deps.guard.acquire(PUSH_DEPENDENCY);
        if (!decision.allowed) throw new PushHeldBack("breaker", decision.retryAt);
        probeToken = decision.probe ? decision.probeToken : null;
      } catch (error) {
        const held = error instanceof PushHeldBack ? error : new PushHeldBack("guard_error", null);
        span.setAttribute("push.held_by", held.by);
        // A check that throws holds the push back: nothing goes out unguarded.
        throw held;
      }
      const report = async (outcome: CallOutcome) => {
        try {
          await deps.guard.report(PUSH_DEPENDENCY, outcome, probeToken);
        } catch {
          span.setAttribute("push.breaker_report_failed", true);
        }
      };

      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: {
            authorization,
            "content-encoding": "aes128gcm",
            "content-type": "application/octet-stream",
            ttl: String(TTL_SECONDS),
            urgency: "high",
          },
          // A copy as a plain Uint8Array, the body type fetch takes.
          body: new Uint8Array(body),
          // A push service never redirects a push; following one would leave the allowlist.
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        await report({ ok: false, error: "PushError" });
        throw new PushError(`push service didn't answer (${(e as Error).name})`, 0);
      }
      span.setAttribute("http.response.status_code", res.status);
      // Only the push service's own trouble counts against the breaker.
      const fault = res.status === 429 || res.status >= 500;
      await report(fault ? { ok: false, error: "PushError" } : { ok: true });
      // The body is never read: it may echo the endpoint.
      await res.body?.cancel().catch(() => undefined);
      if (fault) throw new PushError(`push service answered ${res.status}`, res.status);
      const result: PushResult =
        res.status >= 200 && res.status < 300
          ? "sent"
          : res.status === 404 || res.status === 410
            ? "gone"
            : "rejected";
      span.setAttribute("push.result", result);
      return result;
    },
  };
}
