import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import type { GmailAccess } from "./oauth.js";

// A small read-only Gmail REST client (ADR-0014): list ids, get headers, get the body. Plain
// fetch, no SDK. Retries 429 and 5xx with backoff (ADR-0007); spans carry counts and statuses only.

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
// Headers the pre-filter and INB-011 need; nothing else is fetched before the pre-filter decides.
const METADATA_HEADERS = ["From", "Subject", "Date", "Delivered-To", "Authentication-Results"];
const MAX_RETRIES = 5;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export type GmailDeps = {
  access: GmailAccess;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  // 0..1, for backoff jitter (injected so tests are exact).
  random: () => number;
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
};

type GmailPayload = {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: GmailPayload[];
};
type GmailMessage = { id: string; threadId: string; internalDate: string; payload?: GmailPayload };

export function createGmailClient(deps: GmailDeps): GmailClient {
  const tracer = trace.getTracer("@northstar/inbox");

  // One GET with retries. Records the final status and retry count on the span.
  async function get(url: string, span: Span): Promise<unknown> {
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
        throw new GmailError(`Gmail didn't answer (${(e as Error).name})`, 0);
      }
      span.setAttribute("http.response.status_code", res.status);
      span.setAttribute("gmail.retries", attempt);
      if (res.ok) return res.json();
      if (!RETRYABLE.has(res.status))
        throw new GmailError(`Gmail answered ${res.status}`, res.status);
      if (attempt >= MAX_RETRIES) {
        throw new GmailError(
          `Gmail answered ${res.status} after ${MAX_RETRIES} retries`,
          res.status,
        );
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      await deps.sleep(
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt),
      );
    }
  }

  // 500 ms doubling per attempt, plus up to 250 ms of jitter so retries don't line up.
  const backoff = (attempt: number) => 500 * 2 ** attempt + Math.floor(deps.random() * 250);

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
    getFull: async (id) => {
      const m = await message(id, "full");
      return { ...headersOf(m), body: bodyOf(m.payload) };
    },
  };
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
    deliveredTo: header("Delivered-To"),
    authenticationResults: header("Authentication-Results"),
    receivedAt: new Date(Number(m.internalDate)),
  };
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
