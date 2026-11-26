import { admit, type CallGuard, type GuardOutcome } from "@northstar/llm";
import type { Span } from "@opentelemetry/api";

// One GET to a Google API with retries, Google's reason code and the dependency's breaker
// (NS-250). The Gmail and Calendar clients share it, so their retry rules can't drift apart again.
// Each client keeps its own error class, span attribute prefix and request checks. Errors name
// Google's reason code only, never its message text (which can echo the request).

const MAX_RETRIES = 5;
// A Retry-After longer than this is capped: the in-memory token expires after about an hour.
const MAX_RETRY_AFTER_S = 60;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
// The codes Google uses for "slow down" (documented as retry-with-backoff): reason codes, plus the
// RESOURCE_EXHAUSTED status word for when an error carries no reason.
const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED",
]);

export type GoogleGetConfig = {
  // How messages name the service ("Gmail answered 404").
  label: string;
  // The breaker every read goes through (NS-174, RES-002).
  dependency: string;
  // Span attributes are `<attrPrefix>.retries`, `.held_by`, `.guard_error`, `.breaker_report_failed`.
  attrPrefix: string;
  // The error name reported to the breaker on the service's own failure.
  errorName: string;
  // The client's own error class.
  makeError: (message: string, status: number) => Error;
  // Sent as the request's method when set; otherwise fetch's default (GET).
  method?: "GET";
  // Run first on every read, inside the breaker: an error returned is thrown, nothing is sent,
  // and it is reported as an answer, not the service's failure.
  check?: (url: string) => Error | null;
  // When set, a 200 whose body isn't JSON throws this error instead of the parse error (which can
  // quote the body).
  notJson?: () => Error;
};

export type GoogleGetDeps = {
  authorization: () => string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  // 0..1, for backoff jitter (injected so tests are exact).
  random: () => number;
  // The dependency's breaker. Without one, reads go out unguarded (tests, tools).
  guard?: CallGuard;
};

// Errors that are the service's own trouble (no answer, or a 429, 5xx or rate limit that outlasted
// the retries), as opposed to it answering that the request is wrong (401, 404, other 403s). Only
// these count against its breaker.
const FAULTS = new WeakSet<Error>();
const fault = (e: Error) => {
  FAULTS.add(e);
  return e;
};

// Google's fixed reason code for an error (e.g. accessNotConfigured, SERVICE_DISABLED,
// insufficientPermissions), so Paul can tell a disabled API from a missing scope. Only a plain
// code word is returned: the error's message text can echo request details and is never read.
const REASON_WORD = /^[A-Za-z_]{1,64}$/;
async function errorReason(res: Response): Promise<string | null> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  if (!error || typeof error !== "object") return null;
  const details = Array.isArray(error.details) ? error.details : [];
  const info = details.find(
    (d: { "@type"?: unknown }) =>
      typeof d?.["@type"] === "string" && d["@type"].endsWith("google.rpc.ErrorInfo"),
  ) as { reason?: unknown } | undefined;
  const legacy = Array.isArray(error.errors)
    ? (error.errors[0] as { reason?: unknown } | undefined)
    : undefined;
  // Most specific first: ErrorInfo's reason, then the legacy reason, then the status word.
  for (const candidate of [info?.reason, legacy?.reason, error.status]) {
    if (typeof candidate === "string" && REASON_WORD.test(candidate)) return candidate;
  }
  return null;
}

export function createGoogleGet(
  config: GoogleGetConfig,
  deps: GoogleGetDeps,
): (url: string, span: Span) => Promise<unknown> {
  const { label, attrPrefix } = config;
  // 500 ms doubling per attempt, plus up to 250 ms of jitter so retries don't line up.
  const backoff = (attempt: number) => 500 * 2 ** attempt + Math.floor(deps.random() * 250);
  // Google's quotas are counted per minute, so a rate limit needs longer waits: 2 s doubling,
  // about a minute over 5 retries, plus the same jitter.
  const rateBackoff = (attempt: number) => 2000 * 2 ** attempt + Math.floor(deps.random() * 250);

  // One GET with retries. Records the final status and retry count on the span.
  async function send(url: string, span: Span): Promise<unknown> {
    const refused = config.check?.(url) ?? null;
    if (refused !== null) throw refused;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await deps.fetch(url, {
          ...(config.method ? { method: config.method } : {}),
          headers: { authorization: deps.authorization() },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        // A dropped connection or timeout is retried like a 503.
        if (attempt < MAX_RETRIES) {
          await deps.sleep(backoff(attempt));
          continue;
        }
        throw fault(config.makeError(`${label} didn't answer (${(e as Error).name})`, 0));
      }
      span.setAttribute("http.response.status_code", res.status);
      span.setAttribute(`${attrPrefix}.retries`, attempt);
      if (res.ok) {
        if (!config.notJson) return res.json();
        try {
          return await res.json();
        } catch {
          throw config.notJson();
        }
      }
      const reason = await errorReason(res);
      const said = `${label} answered ${res.status}${reason ? ` (${reason})` : ""}`;
      // Google sends rate limits as 403 too; those are retried, other 403s aren't.
      const rateLimited =
        (res.status === 403 || res.status === 429) &&
        reason !== null &&
        RATE_LIMIT_REASONS.has(reason);
      if (!RETRYABLE.has(res.status) && !rateLimited) throw config.makeError(said, res.status);
      if (attempt >= MAX_RETRIES) {
        throw fault(config.makeError(`${said} after ${MAX_RETRIES} retries`, res.status));
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      await deps.sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter, MAX_RETRY_AFTER_S) * 1000
          : rateLimited
            ? rateBackoff(attempt)
            : backoff(attempt),
      );
    }
  }

  // One read through the breaker: held back (HeldBack, nothing sent) while it is open, and
  // reported after the retries, as the service's failure only when it is the service's.
  return async function get(url: string, span: Span): Promise<unknown> {
    const guard = deps.guard;
    if (!guard) return send(url, span);
    const admission = await admit(guard, { subsystem: null, dependency: config.dependency });
    if (!admission.ok) {
      span.setAttribute(`${attrPrefix}.held_by`, admission.held.by);
      // The error's name only, as the LLM gateway does: its message could name a host.
      if (admission.errorName !== null) {
        span.setAttribute(`${attrPrefix}.guard_error`, admission.errorName);
      }
      throw admission.held;
    }
    const report = async (outcome: GuardOutcome) => {
      try {
        await guard.report(config.dependency, outcome, admission.probeToken);
      } catch {
        span.setAttribute(`${attrPrefix}.breaker_report_failed`, true);
      }
    };
    try {
      const body = await send(url, span);
      await report({ ok: true });
      return body;
    } catch (e) {
      const isFault = e instanceof Error && FAULTS.has(e);
      await report(isFault ? { ok: false, error: config.errorName } : { ok: true });
      throw e;
    }
  };
}
