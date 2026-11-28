import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SpendMeter, Spent } from "../budget.js";
import { HeldBack } from "../guard.js";
import { fakeGuard } from "../test/fake-guard.js";
import {
  createEmbedClient,
  EMBED_DIMENSIONS,
  EMBED_MODEL,
  EMBED_URL,
  EmbedResponseError,
  EmbedTransportError,
  MAX_EMBED_CHARS,
  MAX_EMBED_INPUTS,
} from "./client.js";

// The embeddings client (NS-129, ADR-0033) with OpenAI faked: no test calls the network. The
// key is invented, and the texts are synthetic job lines.

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
afterAll(() => {
  trace.disable();
});
beforeEach(() => {
  exporter.reset();
});

const KEY = "test-key";
const TEXTS = ["Backend Engineer\nExample Corp\nTypeScript", "Data Engineer\nExample Co\nSQL"];
const vector = (n: number) => Array.from({ length: EMBED_DIMENSIONS }, (_, i) => (i + n) / 1000);

type Call = { url: string; init: RequestInit };

// A fake OpenAI: records each request and answers with `answer`.
function fakeFetch(answer: Response | Error | (() => Response)) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer() : answer.clone();
  };
  return { calls, fetch };
}

const okReply = (count = TEXTS.length, tokens = 40) =>
  new Response(
    JSON.stringify({
      object: "list",
      // Out of order on purpose: the client must place each vector by its index.
      data: Array.from({ length: count }, (_, i) => ({
        object: "embedding",
        index: count - 1 - i,
        embedding: vector(count - 1 - i),
      })),
      model: EMBED_MODEL,
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

function meter(spent: Spent = { todayUsd: 0, monthUsd: 0 }): SpendMeter & { recorded: number[] } {
  const recorded: number[] = [];
  return {
    recorded,
    spent: async () => spent,
    record: async (_route, usd) => {
      recorded.push(usd);
    },
  };
}

const spanAttrs = () =>
  exporter.getFinishedSpans().find((s) => s.name === "llm.embed")?.attributes ?? {};

describe("createEmbedClient (NS-129)", () => {
  it("sends one request to OpenAI's embeddings endpoint and returns the vectors in order", async () => {
    const api = fakeFetch(okReply());
    const client = createEmbedClient({ apiKey: KEY, fetch: api.fetch });
    const vectors = await client.embed(TEXTS);
    expect(vectors).toEqual([vector(0), vector(1)]);
    expect(api.calls).toHaveLength(1);
    const [call] = api.calls;
    expect(call?.url).toBe(EMBED_URL);
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("error");
    expect(call?.init.headers).toEqual({
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(String(call?.init.body))).toEqual({
      model: EMBED_MODEL,
      input: TEXTS,
      dimensions: EMBED_DIMENSIONS,
      encoding_format: "float",
    });
  });

  it("never puts the key or the texts on its span", async () => {
    const api = fakeFetch(okReply());
    await createEmbedClient({ apiKey: KEY, fetch: api.fetch }).embed(TEXTS);
    const text = JSON.stringify(spanAttrs());
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("Example Corp");
    expect(spanAttrs()["northstar.llm.inputs"]).toBe(2);
  });

  it("sends nothing while the job-embed switch is off", async () => {
    const api = fakeFetch(okReply());
    const guard = fakeGuard({ off: ["agent:job-embed"] });
    const client = createEmbedClient({ apiKey: KEY, fetch: api.fetch, guard });
    const error = await client.embed(TEXTS).catch((e: unknown) => e);
    expect(error).toEqual(new HeldBack("kill_switch", "agent:job-embed"));
    expect(api.calls).toEqual([]);
  });

  it("sends nothing while the openai breaker is open", async () => {
    const api = fakeFetch(okReply());
    const retryAt = new Date("2026-11-28T07:00:00Z");
    const guard = fakeGuard({
      decisions: { openai: { allowed: false, retryAt, lastError: "EmbedTransportError" } },
    });
    const client = createEmbedClient({ apiKey: KEY, fetch: api.fetch, guard });
    const error = await client.embed(TEXTS).catch((e: unknown) => e);
    expect([error instanceof HeldBack, (error as HeldBack).by, api.calls]).toEqual([
      true,
      "breaker",
      [],
    ]);
  });

  it("sends nothing once spend reaches 80% of a cap, the low priority's share", async () => {
    const api = fakeFetch(okReply());
    const client = createEmbedClient({
      apiKey: KEY,
      fetch: api.fetch,
      budget: {
        caps: { dailyUsd: 10, monthlyUsd: null },
        meter: meter({ todayUsd: 8, monthUsd: 8 }),
      },
    });
    const error = await client.embed(TEXTS).catch((e: unknown) => e);
    expect([error instanceof HeldBack, (error as HeldBack).by, api.calls]).toEqual([
      true,
      "budget",
      [],
    ]);
  });

  it("records each call's cost under the job-embed route", async () => {
    const api = fakeFetch(okReply(2, 1_000_000));
    const m = meter();
    const client = createEmbedClient({
      apiKey: KEY,
      fetch: api.fetch,
      budget: { caps: { dailyUsd: 10, monthlyUsd: null }, meter: m },
    });
    await client.embed(TEXTS);
    expect(m.recorded).toHaveLength(1);
    expect(m.recorded[0]).toBeCloseTo(0.02, 10);
  });

  it("counts a 503 against the breaker and throws a retryable error", async () => {
    const api = fakeFetch(new Response("busy", { status: 503 }));
    const guard = fakeGuard();
    const client = createEmbedClient({ apiKey: KEY, fetch: api.fetch, guard });
    const error = await client.embed(TEXTS).catch((e: unknown) => e);
    expect(error).toEqual(new EmbedTransportError(503, true));
    expect(guard.reports.map((r) => r.outcome)).toEqual([
      { ok: false, error: "EmbedTransportError" },
    ]);
  });

  it("counts no answer against the breaker", async () => {
    const api = fakeFetch(new TypeError("fetch failed"));
    const guard = fakeGuard();
    const client = createEmbedClient({ apiKey: KEY, fetch: api.fetch, guard });
    const error = await client.embed(TEXTS).catch((e: unknown) => e);
    expect([error, guard.reports.map((r) => r.outcome.ok)]).toEqual([
      new EmbedTransportError(null, true),
      [false],
    ]);
  });

  it("doesn't count a 401 against the breaker: the API answered and the key is wrong", async () => {
    const api = fakeFetch(new Response("{}", { status: 401 }));
    const guard = fakeGuard();
    const client = createEmbedClient({ apiKey: KEY, fetch: api.fetch, guard });
    const error = await client.embed(TEXTS).catch((e: unknown) => e);
    expect([error, guard.reports.map((r) => r.outcome)]).toEqual([
      new EmbedTransportError(401, false),
      [{ ok: true }],
    ]);
  });

  it("refuses a reply with the wrong vector size, a missing vector or a repeated index", async () => {
    const replies = [
      { data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 1 }, model: "m" },
      { data: [{ index: 0, embedding: vector(0) }], usage: { prompt_tokens: 1 }, model: "m" },
      {
        data: [
          { index: 0, embedding: vector(0) },
          { index: 0, embedding: vector(1) },
        ],
        usage: { prompt_tokens: 1 },
        model: "m",
      },
    ];
    for (const body of replies) {
      const api = fakeFetch(() => new Response(JSON.stringify(body), { status: 200 }));
      const error = await createEmbedClient({ apiKey: KEY, fetch: api.fetch })
        .embed(TEXTS)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EmbedResponseError);
    }
  });

  it("refuses an empty batch, too many texts, or an empty or overlong text before sending", async () => {
    const api = fakeFetch(okReply());
    const client = createEmbedClient({ apiKey: KEY, fetch: api.fetch });
    for (const texts of [
      [],
      Array.from({ length: MAX_EMBED_INPUTS + 1 }, () => "x"),
      ["  "],
      ["x".repeat(MAX_EMBED_CHARS + 1)],
    ]) {
      await expect(client.embed(texts)).rejects.toBeInstanceOf(RangeError);
    }
    expect(api.calls).toEqual([]);
  });
});
