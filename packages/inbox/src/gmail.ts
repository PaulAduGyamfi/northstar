import { admit, type CallGuard, type GuardOutcome } from "@northstar/llm";
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import type { GmailAccess } from "./oauth.js";

// A small read-only Gmail REST client (ADR-0014): list ids, get headers, get the body. Plain
// fetch, no SDK. Retries 429, 5xx and rate-limit 403s with backoff (ADR-0007; Google sends quota
// errors as 403). Errors name Google's reason code only, never its message text. Spans carry
// counts and statuses only.

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const THREADS = "https://gmail.googleapis.com/gmail/v1/users/me/threads";
// A Retry-After longer than this is capped: the in-memory token expires after about an hour.
const MAX_RETRY_AFTER_S = 60;
// Headers the pre-filter and INB-011 need; nothing else is fetched before the pre-filter decides.
const METADATA_HEADERS = ["From", "Subject", "Date", "Delivered-To", "Authentication-Results"];
const MAX_RETRIES = 5;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
// The breaker every Gmail read goes through (NS-174, RES-002).
export const GMAIL_DEPENDENCY = "gmail";

export type GmailDeps = {
  access: GmailAccess;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  // 0..1, for backoff jitter (injected so tests are exact).
  random: () => number;
  // The `gmail` breaker (NS-174). Without one, reads go out unguarded (tests, tools).
  guard?: CallGuard;
};

export type MessageHeaders = {
  id: string;
  threadId: string;
  from: string;
  // Lower-case domain of the From address; "" when it can't be read.
  senderDomain: string;
  subject: string;
  deliveredTo: string | null;
  authenticationResults: string | null;
  // Gmail's own receive time (internalDate), not the forgeable Date header.
  receivedAt: Date;
};

export type FullMessage = MessageHeaders & { body: string };

export class GmailError extends Error {
  override name = "GmailError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type GmailClient = {
  listIds: (query: string) => Promise<{ id: string; threadId: string }[]>;
  getHeaders: (id: string) => Promise<MessageHeaders>;
  getFull: (id: string) => Promise<FullMessage>;
  // Every message id in a thread. A search lists matching messages, not whole threads, so this is
  // how a reply titled "Intro call" in a confirmation's thread is found at all.
  threadMessageIds: (threadId: string) => Promise<{ id: string; threadId: string }[]>;
};

type GmailPayload = {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: GmailPayload[];
};
type GmailMessage = { id: string; threadId: string; internalDate: string; payload?: GmailPayload };

// Errors that are Gmail's own trouble (no answer, or a 429, 5xx or rate limit that outlasted the
// retries), as opposed to Gmail answering that our request is wrong (401, 404, other 403s). Only
// these count against its breaker.
const GMAIL_FAULTS = new WeakSet<GmailError>();
const gmailFault = (e: GmailError) => {
  GMAIL_FAULTS.add(e);
  return e;
};

export function createGmailClient(deps: GmailDeps): GmailClient {
  const tracer = trace.getTracer("@northstar/inbox");

  // One read through the `gmail` breaker: held back (HeldBack, nothing sent) while it is open,
  // and reported after the retries, as Gmail's failure only when it is Gmail's.
  async function get(url: string, span: Span): Promise<unknown> {
    const guard = deps.guard;
    if (!guard) return send(url, span);
    const admission = await admit(guard, { subsystem: null, dependency: GMAIL_DEPENDENCY });
    if (!admission.ok) {
      span.setAttribute("gmail.held_by", admission.held.by);
      // The error's name only, as the LLM gateway does: its message could name a host.
      if (admission.errorName !== null) span.setAttribute("gmail.guard_error", admission.errorName);
      throw admission.held;
    }
    const report = async (outcome: GuardOutcome) => {
      try {
        await guard.report(GMAIL_DEPENDENCY, outcome, admission.probeToken);
      } catch {
        span.setAttribute("gmail.breaker_report_failed", true);
      }
    };
    try {
      const body = await send(url, span);
      await report({ ok: true });
      return body;
    } catch (e) {
      const fault = e instanceof GmailError && GMAIL_FAULTS.has(e);
      await report(fault ? { ok: false, error: "GmailError" } : { ok: true });
      throw e;
    }
  }

  // One GET with retries. Records the final status and retry count on the span.
  async function send(url: string, span: Span): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await deps.fetch(url, {
          headers: { authorization: deps.access.authorization() },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        // A dropped connection or timeout is retried like a 503.
        if (attempt < MAX_RETRIES) {
          await deps.sleep(backoff(attempt));
          continue;
        }
        throw gmailFault(new GmailError(`Gmail didn't answer (${(e as Error).name})`, 0));
      }
      span.setAttribute("http.response.status_code", res.status);
      span.setAttribute("gmail.retries", attempt);
      if (res.ok) return res.json();
      const reason = await errorReason(res);
      const said = `Gmail answered ${res.status}${reason ? ` (${reason})` : ""}`;
      // Google sends rate limits as 403 too; those are retried, other 403s aren't.
      const rateLimited =
        (res.status === 403 || res.status === 429) &&
        reason !== null &&
        RATE_LIMIT_REASONS.has(reason);
      if (!RETRYABLE.has(res.status) && !rateLimited) throw new GmailError(said, res.status);
      if (attempt >= MAX_RETRIES) {
        throw gmailFault(new GmailError(`${said} after ${MAX_RETRIES} retries`, res.status));
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

  // 500 ms doubling per attempt, plus up to 250 ms of jitter so retries don't line up.
  const backoff = (attempt: number) => 500 * 2 ** attempt + Math.floor(deps.random() * 250);
  // Gmail's quotas are counted per minute, so a rate limit needs longer waits: 2 s doubling,
  // about a minute over 5 retries, plus the same jitter.
  const rateBackoff = (attempt: number) => 2000 * 2 ** attempt + Math.floor(deps.random() * 250);

  async function inSpan<T>(
    name: string,
    attrs: Record<string, string>,
    fn: (s: Span) => Promise<T>,
  ) {
    return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
      try {
        return await fn(span);
      } catch (e) {
        // The error's name and status only: its message never holds mail content.
        span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).name });
        throw e;
      } finally {
        span.end();
      }
    });
  }

  async function message(id: string, format: "metadata" | "full"): Promise<GmailMessage> {
    const url = new URL(`${BASE}/${encodeURIComponent(id)}`);
    url.searchParams.set("format", format);
    if (format === "metadata") {
      for (const h of METADATA_HEADERS) url.searchParams.append("metadataHeaders", h);
    }
    return inSpan("gmail.get", { "gmail.format": format }, (span) =>
      get(url.toString(), span),
    ) as Promise<GmailMessage>;
  }

  return {
    listIds: (query) =>
      inSpan("gmail.list", {}, async (span) => {
        const ids: { id: string; threadId: string }[] = [];
        let pageToken: string | undefined;
        do {
          const url = new URL(BASE);
          url.searchParams.set("q", query);
          url.searchParams.set("maxResults", "500");
          if (pageToken) url.searchParams.set("pageToken", pageToken);
          const page = (await get(url.toString(), span)) as {
            messages?: { id: string; threadId: string }[];
            nextPageToken?: string;
          };
          ids.push(...(page.messages ?? []).map((m) => ({ id: m.id, threadId: m.threadId })));
          pageToken = page.nextPageToken;
        } while (pageToken);
        span.setAttribute("gmail.count", ids.length);
        return ids;
      }),
    getHeaders: async (id) => headersOf(await message(id, "metadata")),
    threadMessageIds: (threadId) =>
      inSpan("gmail.thread", {}, async (span) => {
        // format=minimal: ids and labels only, no headers or body.
        const url = `${THREADS}/${encodeURIComponent(threadId)}?format=minimal`;
        const thread = (await get(url, span)) as { messages?: { id: string; threadId: string }[] };
        const ids = (thread.messages ?? []).map((m) => ({ id: m.id, threadId: m.threadId }));
        span.setAttribute("gmail.count", ids.length);
        return ids;
      }),
    getFull: async (id) => {
      const m = await message(id, "full");
      return { ...headersOf(m), body: bodyOf(m.payload) };
    },
  };
}

// Gmail's own Authentication-Results header (authserv-id mx.google.com), not just the first one.
// Gmail adds its header above everything the sender wrote, so the first mx.google.com match is
// Gmail's, and a forged one (with that authserv-id or another) below it is never read. A message
// with no Google header reads the first one, as before (see #205).
const GOOGLE_AUTHSERV = /^\s*mx\.google\.com\s*;/i;
function authenticationResults(m: GmailMessage): string | null {
  const all = (m.payload?.headers ?? [])
    .filter((h) => h.name.toLowerCase() === "authentication-results")
    .map((h) => h.value);
  return all.find((v) => GOOGLE_AUTHSERV.test(v)) ?? all[0] ?? null;
}

// Gmail's own Delivered-To (INB-011, NS-188): Gmail adds one at the top of each message it
// delivers, above anything the sender or an earlier hop wrote, so the first is Gmail's and any
// below it (a forwarded copy's, or one the sender put in) is never read for a tag.
function deliveredTo(m: GmailMessage): string | null {
  const first = (m.payload?.headers ?? []).find((h) => h.name.toLowerCase() === "delivered-to");
  return first?.value ?? null;
}

function headersOf(m: GmailMessage): MessageHeaders {
  const header = (name: string) =>
    m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
  const from = header("From") ?? "";
  return {
    id: m.id,
    threadId: m.threadId,
    from,
    senderDomain: senderDomain(from),
    subject: header("Subject") ?? "",
    deliveredTo: deliveredTo(m),
    authenticationResults: authenticationResults(m),
    receivedAt: new Date(Number(m.internalDate)),
  };
}

// Google's fixed reason code for an error (e.g. accessNotConfigured, SERVICE_DISABLED,
// insufficientPermissions), so Paul can tell a disabled API from a missing scope. Only a plain
// code word is returned: the error's message text can echo request details and is never read.
const REASON_WORD = /^[A-Za-z_]{1,64}$/;
// The codes Gmail uses for "slow down" (documented as retry-with-backoff): reason codes, plus the
// RESOURCE_EXHAUSTED status word for when an error carries no reason.
const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED",
]);
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
    ? (error.errors[0] as { reason?: unknown })
    : undefined;
  // Most specific first: ErrorInfo's reason, then the legacy reason, then the status word.
  for (const candidate of [info?.reason, legacy?.reason, error.status]) {
    if (typeof candidate === "string" && REASON_WORD.test(candidate)) return candidate;
  }
  return null;
}

// "Name <a@example.com>" or "a@example.com" → "example.com".
export function senderDomain(from: string): string {
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const at = address.lastIndexOf("@");
  return at < 0
    ? ""
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

// The plain-text part if there is one, else the HTML part as text.
function bodyOf(payload: GmailPayload | undefined): string {
  const parts: GmailPayload[] = [];
  const walk = (p: GmailPayload | undefined) => {
    if (!p) return;
    parts.push(p);
    for (const child of p.parts ?? []) walk(child);
  };
  walk(payload);
  const decode = (p: GmailPayload) => Buffer.from(p.body?.data ?? "", "base64url").toString("utf8");
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain) return decode(plain).trim();
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
  return html ? htmlToText(decode(html)) : "";
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
