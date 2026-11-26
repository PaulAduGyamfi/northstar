import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CallGuard, GuardOutcome } from "@northstar/llm";
import { trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { createGoogleGet } from "./google-get.js";

// The shared Google GET (NS-250), run directly against a scripted fetch. Synthetic URLs only.

const URL_ = "https://www.googleapis.com/example/v1/things";

class ExampleError extends Error {
  override name = "ExampleError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Step = Response | Error;

// A fetch that answers each call with the next scripted step, recording the calls.
function scripted(steps: Step[]) {
  const calls: RequestInit[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    const step = steps.shift();
    if (step === undefined) throw new Error("no more scripted answers");
    if (step instanceof Error) throw step;
    return step;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

// A guard that always allows and records every report.
function recordingGuard() {
  const reports: GuardOutcome[] = [];
  const guard: CallGuard = {
    isOn: async () => true,
    acquire: async () => ({ allowed: true, probe: false }),
    report: async (_dependency, outcome) => {
      reports.push(outcome);
    },
  };
  return { guard, reports };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function getWith(steps: Step[], guard?: CallGuard) {
  const sleeps: number[] = [];
  const { fetch, calls } = scripted(steps);
  const get = createGoogleGet(
    {
      label: "Example",
      dependency: "example",
      attrPrefix: "example",
      errorName: "ExampleError",
      makeError: (message, status) => new ExampleError(message, status),
    },
    {
      authorization: () => "Bearer ya29.test-access-token",
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0,
      ...(guard ? { guard } : {}),
    },
  );
  const span = trace.getTracer("test").startSpan("example");
  return { run: () => get(URL_, span), sleeps, calls };
}

describe("the shared Google GET", () => {
  it("waits the server's Retry-After, capped at 60 seconds, before retrying", async () => {
    const { run, sleeps } = getWith([
      json(503, {}, { "retry-after": "7" }),
      json(503, {}, { "retry-after": "600" }),
      json(200, { ok: 1 }),
    ]);
    expect(await run()).toEqual({ ok: 1 });
    expect(sleeps).toEqual([7000, 60000]);
  });

  it("retries a rate-limit 403 with the longer backoff, and not another 403", async () => {
    const limited = { error: { errors: [{ reason: "rateLimitExceeded" }] } };
    const { run, sleeps } = getWith([json(403, limited), json(200, { ok: 1 })]);
    expect(await run()).toEqual({ ok: 1 });
    expect(sleeps).toEqual([2000]);

    const denied = { error: { errors: [{ reason: "insufficientPermissions" }] } };
    const other = getWith([json(403, denied)]);
    await expect(other.run()).rejects.toEqual(
      new ExampleError("Example answered 403 (insufficientPermissions)", 403),
    );
    expect(other.sleeps).toEqual([]);
  });

  it("retries a dropped connection, then names it after five retries", async () => {
    const dropped = () => Object.assign(new Error("socket hang up"), { name: "TypeError" });
    const { run, sleeps } = getWith(Array.from({ length: 6 }, dropped));
    await expect(run()).rejects.toEqual(new ExampleError("Example didn't answer (TypeError)", 0));
    expect(sleeps).toEqual([500, 1000, 2000, 4000, 8000]);
  });

  it("reports a 404 to the breaker as an answer, and a lasting 503 as the service's failure", async () => {
    const notFound = recordingGuard();
    await expect(getWith([json(404, {})], notFound.guard).run()).rejects.toEqual(
      new ExampleError("Example answered 404", 404),
    );
    expect(notFound.reports).toEqual([{ ok: true }]);

    const down = recordingGuard();
    const steps = Array.from({ length: 6 }, () => json(503, {}));
    await expect(getWith(steps, down.guard).run()).rejects.toEqual(
      new ExampleError("Example answered 503 after 5 retries", 503),
    );
    expect(down.reports).toEqual([{ ok: false, error: "ExampleError" }]);
  });

  it("prefers Google's ErrorInfo reason over the legacy reason and the status word", async () => {
    const body = {
      error: {
        status: "PERMISSION_DENIED",
        errors: [{ reason: "forbidden" }],
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" },
        ],
      },
    };
    await expect(getWith([json(403, body)]).run()).rejects.toEqual(
      new ExampleError("Example answered 403 (SERVICE_DISABLED)", 403),
    );
  });

  it("sends the authorization header and no other request options than it was given", async () => {
    const { run, calls } = getWith([json(200, {})]);
    await run();
    expect(calls.map((c) => [c.method, c.headers])).toEqual([
      [undefined, { authorization: "Bearer ya29.test-access-token" }],
    ]);
    // Exactly these request options: never a body or another method.
    expect(calls.map((c) => Object.keys(c).sort())).toEqual([["headers", "signal"]]);
  });
});

// Security review of NS-250: the request code now lives outside src/calendar/, so the Calendar
// boundary scan no longer reads it, and any client could import it with any token. These two
// scans are its own tripwires.
const src = fileURLToPath(new URL(".", import.meta.url));
// Comments are left out: they say what the helper must never do.
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("the shared Google GET's boundary", () => {
  it("only ever reads: no write method and no request body", () => {
    const text = code(readFileSync(`${src}/google-get.ts`, "utf8"));
    expect([/\b(POST|PUT|PATCH|DELETE)\b/.test(text), /\bbody\s*:/.test(text)]).toEqual([
      false,
      false,
    ]);
  });

  it("is imported only by the Gmail reader and the Calendar client, never the label writer", () => {
    const sources = (readdirSync(src, { recursive: true }) as string[]).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "google-get.ts",
    );
    const importers = sources
      .filter((f) => /["'][^"']*google-get(\.js)?["']/.test(readFileSync(`${src}/${f}`, "utf8")))
      .map((f) => f.split("\\").join("/"))
      .sort();
    expect(importers).toEqual(["calendar/client.ts", "gmail.ts"]);
  });
});
