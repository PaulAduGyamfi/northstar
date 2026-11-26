import type { CallGuard } from "@northstar/llm";
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { createGoogleGet } from "./google-get.js";
import type { GmailAccess } from "./oauth.js";
import { GMAIL_AUTHSERV } from "./prefilter.js";

// A small read-only Gmail REST client (ADR-0014): list ids, get headers, get the body. Plain
// fetch, no SDK. Retries 429, 5xx and rate-limit 403s with backoff (ADR-0007; Google sends quota
// errors as 403). Errors name Google's reason code only, never its message text. Spans carry
// counts and statuses only.

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const THREADS = "https://gmail.googleapis.com/gmail/v1/users/me/threads";
const PROFILE = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
// Headers the pre-filter and INB-011 need; nothing else is fetched before the pre-filter decides.
const METADATA_HEADERS = ["From", "Subject", "Date", "Delivered-To", "Authentication-Results"];
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
  // Gmail's labels on the message (SENT, DRAFT, INBOX, …), set by Gmail, never by the sender.
  // Absent when the message has none (Gmail leaves an empty list out), such as mail a filter
  // archived and marked read. Sent mail and drafts always carry SENT or DRAFT (#224).
  labelIds?: readonly string[];
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
  // The mailbox's own address (users.getProfile), for telling mail Gmail delivered to Paul from
  // mail whose Delivered-To someone else wrote (#224, INB-011).
  profileAddress: () => Promise<string>;
};

type GmailPayload = {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: GmailPayload[];
};
type GmailMessage = {
  id: string;
  threadId: string;
  internalDate: string;
  labelIds?: string[];
  payload?: GmailPayload;
};

export function createGmailClient(deps: GmailDeps): GmailClient {
  const tracer = trace.getTracer("@northstar/inbox");

  // Retries, Google's reason code and the `gmail` breaker: the shared Google GET (NS-250).
  const get = createGoogleGet(
    {
      label: "Gmail",
      dependency: GMAIL_DEPENDENCY,
      attrPrefix: "gmail",
      errorName: "GmailError",
      makeError: (message, status) => new GmailError(message, status),
    },
    {
      authorization: () => deps.access.authorization(),
      fetch: deps.fetch,
      sleep: deps.sleep,
      random: deps.random,
      ...(deps.guard ? { guard: deps.guard } : {}),
    },
  );

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
    profileAddress: () =>
      inSpan("gmail.profile", {}, async (span) => {
        const profile = (await get(PROFILE, span)) as { emailAddress?: unknown };
        // Never on the span: it is Paul's address.
        if (typeof profile.emailAddress !== "string" || !profile.emailAddress.includes("@")) {
          throw new GmailError("Gmail's profile had no email address", 200);
        }
        return profile.emailAddress;
      }),
  };
}

// Gmail's own Authentication-Results header (authserv-id mx.google.com) and no other. Gmail adds
// its header above everything the sender wrote, so the first mx.google.com match is Gmail's, and a
// forged one (with that authserv-id or another) below it is never read. A message with no Google
// header has no results at all: its sender is unverified (NS-217).
function authenticationResults(m: GmailMessage): string | null {
  const all = (m.payload?.headers ?? [])
    .filter((h) => h.name.toLowerCase() === "authentication-results")
    .map((h) => h.value);
  return all.find((v) => GMAIL_AUTHSERV.test(v)) ?? null;
}

// Gmail's own Delivered-To (INB-011, NS-188): on mail Gmail received, it adds one at the top,
// above anything the sender or an earlier hop wrote, so the first is Gmail's and any below it (a
// forwarded copy's, or one the sender put in) is never read for a tag. Mail Gmail never stamped
// (Sent, drafts, messages added by insert or import) has no trustworthy Delivered-To at all: the
// mail-link loop must skip those and check the address is Paul's own mailbox (#224).
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
    // Only strings: anything else in the array is dropped rather than trusted. Gmail leaves an
    // empty list out of its JSON, so a message with no labels has no field here either.
    ...(Array.isArray(m.labelIds)
      ? { labelIds: m.labelIds.filter((l): l is string => typeof l === "string") }
      : {}),
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
