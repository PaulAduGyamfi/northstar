import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { safeFetch } from "./fetch.js";
import { fakeWeb } from "./test/fake-web.js";

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
beforeEach(() => exporter.reset());

// Synthetic page only.
describe("source.fetch span", () => {
  it("records the host, status, bytes and redirects, never the path or page content", async () => {
    const { deps } = fakeWeb({
      "https://jobs.example.com/a?search=secret-term": { status: 302, location: "/b" },
      "https://jobs.example.com/b": { body: "Globex Backend Engineer" },
    });
    await safeFetch(deps, "https://jobs.example.com/a?search=secret-term");
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("source.fetch");
    expect(span?.attributes).toEqual({
      "server.address": "jobs.example.com",
      "http.response.status_code": 200,
      "source.bytes": 23,
      "source.redirects": 1,
    });
    const all = JSON.stringify(span?.attributes);
    for (const s of ["secret-term", "Globex", "/a"]) expect(all).not.toContain(s);
  });

  it("marks a refused fetch as an error by name only", async () => {
    const { deps } = fakeWeb({});
    await safeFetch(deps, "http://jobs.example.com/1").catch(() => {});
    const [span] = exporter.getFinishedSpans();
    expect(span?.status).toEqual({ code: 2, message: "FetchRefused" });
  });
});
