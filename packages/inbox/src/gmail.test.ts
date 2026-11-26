import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGmailClient, GmailError } from "./gmail.js";
import { GmailAccess } from "./oauth.js";
import { type FakeMessage, fakeGmail } from "./test/fake-gmail.js";

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
beforeEach(() => exporter.reset());

const TOKEN = "ya29.test-access-token";
const access = new GmailAccess(TOKEN);

// Synthetic mail only (the repo is public).
const message: FakeMessage = {
  id: "m1",
  threadId: "t1",
  internalDate: "2026-03-02T15:00:00Z",
  headers: {
    From: "Globex Recruiting <no-reply.ats@example.com>",
    Subject: "Thank you for applying to Globex",
    Date: "Mon, 2 Mar 2026 15:00:00 +0000",
    "Delivered-To": "candidate@example.com",
    "Authentication-Results": "mx.example.com; dmarc=pass header.from=ats.example.com",
  },
  text: "Hi, we received your application for Backend Engineer.",
};

const sleeps: number[] = [];
// Google's error body for a rate limit, with the given reason code.
const limited = (reason: string) =>
  JSON.stringify({ error: { code: 403, errors: [{ reason }], status: "PERMISSION_DENIED" } });
const client = (gmail: ReturnType<typeof fakeGmail>) =>
  createGmailClient({
    access,
    fetch: gmail.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
  });

describe("gmail client", () => {
  beforeEach(() => {
    sleeps.length = 0;
  });

  it("lists every page of message ids for a query", async () => {
    const gmail = fakeGmail(
      Array.from({ length: 3 }, (_, i) => ({ ...message, id: `m${i}` })),
      { pageSize: 2 },
    );
    expect(await client(gmail).listIds("after:2026/02/01")).toEqual([
      { id: "m0", threadId: "t1" },
      { id: "m1", threadId: "t1" },
      { id: "m2", threadId: "t1" },
    ]);
    expect(gmail.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("fetches headers only, with format=metadata", async () => {
    const gmail = fakeGmail([message]);
    const h = await client(gmail).getHeaders("m1");
    expect(h).toEqual({
      id: "m1",
      threadId: "t1",
      from: "Globex Recruiting <no-reply.ats@example.com>",
      senderDomain: "example.com",
      subject: "Thank you for applying to Globex",
      deliveredTo: "candidate@example.com",
      authenticationResults: "mx.example.com; dmarc=pass header.from=ats.example.com",
      receivedAt: new Date("2026-03-02T15:00:00Z"),
    });
    expect(gmail.requests.at(-1)?.url).toContain("format=metadata");
  });

  it("reads Gmail's own Delivered-To, the top one, never a tagged one below it (NS-188)", async () => {
    const forwarded = {
      ...message,
      headers: { ...message.headers, "Delivered-To": "candidate@example.com" },
      extraHeaders: [{ name: "Delivered-To", value: "candidate+ns-abcdef@example.com" }],
    };
    const h = await client(fakeGmail([forwarded])).getHeaders("m1");
    expect(h.deliveredTo).toBe("candidate@example.com");
  });

  it("reads the tag Gmail delivered to when its own Delivered-To carries one", async () => {
    const tagged = {
      ...message,
      headers: { ...message.headers, "Delivered-To": "candidate+ns-abcdef@example.com" },
      extraHeaders: [{ name: "Delivered-To", value: "someone@example.com" }],
    };
    const h = await client(fakeGmail([tagged])).getHeaders("m1");
    expect(h.deliveredTo).toBe("candidate+ns-abcdef@example.com");
  });

  it("reads Gmail's own Authentication-Results header even when another comes first", async () => {
    const forged = {
      ...message,
      headers: {
        ...message.headers,
        "Authentication-Results": "mx.example.com; dmarc=pass header.from=forged.example.com",
      },
      extraHeaders: [
        {
          name: "Authentication-Results",
          value: "mx.google.com; dmarc=pass header.from=ats.example.com",
        },
      ],
    };
    const h = await client(fakeGmail([forged])).getHeaders("m1");
    expect(h.authenticationResults).toBe("mx.google.com; dmarc=pass header.from=ats.example.com");
  });

  it("reads the first of two Google headers: Gmail's stamp is the top one", async () => {
    const twice = {
      ...message,
      headers: {
        ...message.headers,
        "Authentication-Results": "mx.google.com; dmarc=pass header.from=ats.example.com",
      },
      extraHeaders: [
        {
          name: "Authentication-Results",
          value: "mx.google.com; dmarc=pass header.from=forged.example.com",
        },
      ],
    };
    const h = await client(fakeGmail([twice])).getHeaders("m1");
    expect(h.authenticationResults).toBe("mx.google.com; dmarc=pass header.from=ats.example.com");
  });

  it("doesn't take a look-alike authserv-id for Google's", async () => {
    const lookalike = {
      ...message,
      headers: {
        ...message.headers,
        "Authentication-Results": "mx.example.com; dmarc=pass header.from=ats.example.com",
      },
      extraHeaders: [
        {
          name: "Authentication-Results",
          value: "mx.google.com.evil.example; dmarc=pass header.from=forged.example.com",
        },
      ],
    };
    const h = await client(fakeGmail([lookalike])).getHeaders("m1");
    expect(h.authenticationResults).toBe("mx.example.com; dmarc=pass header.from=ats.example.com");
  });

  it("fetches the plain-text body of a full message", async () => {
    const full = await client(fakeGmail([message])).getFull("m1");
    expect(full.body).toBe("Hi, we received your application for Backend Engineer.");
  });

  it("falls back to the HTML part with tags removed when there's no plain text", async () => {
    const html = { ...message, text: undefined, html: "<p>Hi <b>there</b></p><style>x{}</style>" };
    const full = await client(fakeGmail([html])).getFull("m1");
    expect(full.body).toBe("Hi there");
  });

  it("retries a 429 after the Retry-After delay, then succeeds", async () => {
    const gmail = fakeGmail([message], { failures: [{ status: 429, retryAfter: "3" }] });
    await client(gmail).getHeaders("m1");
    expect(sleeps).toEqual([3000]);
  });

  it("retries 5xx with growing backoff and gives up after 5 retries with the status", async () => {
    const gmail = fakeGmail([message], {
      failures: Array.from({ length: 6 }, () => ({ status: 503 })),
    });
    await expect(client(gmail).getHeaders("m1")).rejects.toThrow(
      new GmailError("Gmail answered 503 after 5 retries", 503),
    );
    expect(sleeps).toEqual([500, 1000, 2000, 4000, 8000]);
  });

  it("caps a Retry-After at 60 seconds", async () => {
    const gmail = fakeGmail([message], { failures: [{ status: 429, retryAfter: "86400" }] });
    await client(gmail).getHeaders("m1");
    expect(sleeps).toEqual([60_000]);
  });

  it("lists every message in a thread with format=minimal", async () => {
    const reply = { ...message, id: "m2", headers: { ...message.headers, Subject: "Intro call" } };
    const other = { ...message, id: "m3", threadId: "t9" };
    const gmail = fakeGmail([message, reply, other]);
    expect(await client(gmail).threadMessageIds("t1")).toEqual([
      { id: "m1", threadId: "t1" },
      { id: "m2", threadId: "t1" },
    ]);
    expect(gmail.requests.at(-1)?.url).toContain("/threads/t1?format=minimal");
  });

  it("doesn't retry a 404", async () => {
    const gmail = fakeGmail([message], { failures: [{ status: 404 }] });
    await expect(client(gmail).getHeaders("m1")).rejects.toThrow("Gmail answered 404");
    expect(sleeps).toEqual([]);
  });

  it("names Google's reason code for a 403, so a disabled API can be told from a missing scope", async () => {
    // Google's error shape: a fixed reason code plus free text that may echo request details.
    const body = JSON.stringify({
      error: {
        code: 403,
        message: "Gmail API has not been used in project 123 before or it is disabled.",
        status: "PERMISSION_DENIED",
        errors: [{ reason: "accessNotConfigured", message: "free text", domain: "usageLimits" }],
      },
    });
    const gmail = fakeGmail([message], { failures: [{ status: 403, body }] });
    const error = await client(gmail)
      .getHeaders("m1")
      .catch((e: unknown) => e);
    expect(error).toEqual(new GmailError("Gmail answered 403 (accessNotConfigured)", 403));
    expect(String((error as Error).message)).not.toContain("project 123");
  });

  it("prefers the ErrorInfo reason over the legacy reason", async () => {
    const info = JSON.stringify({
      error: {
        status: "PERMISSION_DENIED",
        errors: [{ reason: "accessNotConfigured" }],
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" },
        ],
      },
    });
    const gmail = fakeGmail([message], { failures: [{ status: 403, body: info }] });
    await expect(client(gmail).getHeaders("m1")).rejects.toThrow(
      new GmailError("Gmail answered 403 (SERVICE_DISABLED)", 403),
    );
  });

  it("falls back to the status word when there is no reason", async () => {
    const body = JSON.stringify({ error: { status: "PERMISSION_DENIED" } });
    const gmail = fakeGmail([message], { failures: [{ status: 403, body }] });
    await expect(client(gmail).getHeaders("m1")).rejects.toThrow(
      new GmailError("Gmail answered 403 (PERMISSION_DENIED)", 403),
    );
  });

  it("retries a rate-limit 403 with a longer backoff, then succeeds", async () => {
    const gmail = fakeGmail([message], {
      failures: [
        { status: 403, body: limited("RATE_LIMIT_EXCEEDED") },
        { status: 403, body: limited("userRateLimitExceeded") },
      ],
    });
    await client(gmail).getHeaders("m1");
    expect(sleeps).toEqual([2000, 4000]);
  });

  it("gives up on a rate-limit 403 after 5 retries, naming the reason", async () => {
    const body = JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }] } });
    const gmail = fakeGmail([message], {
      failures: Array.from({ length: 6 }, () => ({ status: 403, body })),
    });
    await expect(client(gmail).getHeaders("m1")).rejects.toThrow(
      new GmailError("Gmail answered 403 (rateLimitExceeded) after 5 retries", 403),
    );
    expect(sleeps).toEqual([2000, 4000, 8000, 16000, 32000]);
  });

  it("lets a Retry-After header win over the rate-limit backoff", async () => {
    const gmail = fakeGmail([message], {
      failures: [{ status: 403, retryAfter: "3", body: limited("rateLimitExceeded") }],
    });
    await client(gmail).getHeaders("m1");
    expect(sleeps).toEqual([3000]);
  });

  it("gives a rate-limit 429 the same longer backoff as a rate-limit 403", async () => {
    const gmail = fakeGmail([message], {
      failures: [{ status: 429, body: limited("rateLimitExceeded") }],
    });
    await client(gmail).getHeaders("m1");
    expect(sleeps).toEqual([2000]);
  });

  it("drops a reason that isn't a plain code word", async () => {
    const odd = JSON.stringify({
      error: { errors: [{ reason: "see <script> or a@example.com" }] },
    });
    const gmail = fakeGmail([message], { failures: [{ status: 403, body: odd }] });
    await expect(client(gmail).getHeaders("m1")).rejects.toThrow(
      new GmailError("Gmail answered 403", 403),
    );
  });

  it("names no reason when the error body isn't JSON", async () => {
    const gmail = fakeGmail([message], {
      failures: [{ status: 403, body: "<html>Forbidden</html>" }],
    });
    await expect(client(gmail).getHeaders("m1")).rejects.toThrow(
      new GmailError("Gmail answered 403", 403),
    );
  });

  it("spans carry the status and retry count, never the subject, address or token", async () => {
    const gmail = fakeGmail([message], { failures: [{ status: 429, retryAfter: "1" }] });
    await client(gmail).getFull("m1");
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(["gmail.get"]);
    expect(spans[0]?.attributes).toEqual({
      "gmail.format": "full",
      "http.response.status_code": 200,
      "gmail.retries": 1,
    });
    const all = JSON.stringify(spans.map((s) => [s.attributes, s.events]));
    for (const secret of [TOKEN, "Globex", "example.com", "Backend"]) {
      expect(all).not.toContain(secret);
    }
  });
});
