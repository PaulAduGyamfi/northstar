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

  it("doesn't retry a 404", async () => {
    const gmail = fakeGmail([message], { failures: [{ status: 404 }] });
    await expect(client(gmail).getHeaders("m1")).rejects.toThrow("Gmail answered 404");
    expect(sleeps).toEqual([]);
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
