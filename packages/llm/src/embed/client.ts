import { SpanStatusCode, trace } from "@opentelemetry/api";
import { z } from "zod";
import { budgetHold, type LlmBudget, type SpendMeter } from "../budget.js";
import { admit, type CallGuard, type GuardOutcome, HeldBack } from "../guard.js";

// The embeddings client (NS-129, ADR-0033): one request shape, to one host, with plain fetch and
// no SDK. It runs behind the `agent:job-embed` kill switch, the `openai` breaker and the shared
// LLM spend cap, like a model route. It never logs or spans the text it sends or the key.

// The model, its vector size and the only endpoint. Every stored vector is stamped with the model
// and dimensions, so changing either re-embeds rather than mixing vectors.
export const EMBED_MODEL = "text-embedding-3-small";
export const EMBED_DIMENSIONS = 512;
export const EMBED_URL = "https://api.openai.com/v1/embeddings";
export const OPENAI_DEPENDENCY = "openai";
export const EMBED_ROUTE = "job-embed";
// Dedupe isn't urgent: it is the first work held back when spend runs high (ADR-0021).
export const EMBED_PRIORITY = "low" as const;
// US dollars per input token (about $0.02 per million at the time of writing; ADR-0033 asks Paul
// to check the price list before turning this on).
export const EMBED_USD_PER_TOKEN = 0.02 / 1_000_000;
// A request's limits: a pass embeds a batch of jobs, each a few hundred tokens of text.
export const MAX_EMBED_INPUTS = 64;
export const MAX_EMBED_CHARS = 8_000;
// RES-005: no call waits forever.
export const EMBED_TIMEOUT_MS = 20_000;

// A failure to reach or be served by the API. `retryable` for no answer, 408, 409, 429 and 5xx;
// those also count against the breaker. Status only: a body could quote the request.
export class EmbedTransportError extends Error {
  override name = "EmbedTransportError";
  constructor(
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(`EmbedTransportError status=${status ?? "none"} retryable=${retryable}`);
  }
}

// An answer that isn't the shape we asked for (wrong count, size or order): a bug or an API
// change, never guessed into vectors.
export class EmbedResponseError extends Error {
  override name = "EmbedResponseError";
}

const Reply = z.object({
  data: z.array(
    z.object({
      index: z.number().int().min(0),
      embedding: z.array(z.number().finite()).length(EMBED_DIMENSIONS),
    }),
  ),
  model: z.string(),
  usage: z.object({ prompt_tokens: z.number().int().min(0) }),
});

const isRetryableStatus = (status: number) =>
  status === 408 || status === 409 || status === 429 || status >= 500;

export type EmbedFetch = (url: string, init: RequestInit) => Promise<Response>;

export type EmbedClient = {
  // One vector per text, in the texts' order.
  embed: (texts: readonly string[]) => Promise<number[][]>;
};

export function createEmbedClient(deps: {
  apiKey: string;
  guard?: CallGuard;
  budget?: { caps: LlmBudget; meter: SpendMeter };
  // The global fetch unless a test passes its own; it is only ever called with EMBED_URL.
  fetch?: EmbedFetch;
}): EmbedClient {
  const tracer = trace.getTracer("@northstar/llm");
  const send: EmbedFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  // Costs the meter didn't take, kept until it does: failing writes must not switch the cap off.
  const unrecorded: number[] = [];
  const flush = async (meter: SpendMeter): Promise<boolean> => {
    while (unrecorded.length > 0) {
      const usd = unrecorded[0] ?? 0;
      try {
        await meter.record(EMBED_ROUTE, usd);
      } catch {
        return false;
      }
      unrecorded.shift();
    }
    return true;
  };

  return {
    embed(texts) {
      return tracer.startActiveSpan("llm.embed", async (span) => {
        let probeToken: string | null = null;
        const report = async (outcome: GuardOutcome) => {
          if (!deps.guard) return;
          try {
            await deps.guard.report(OPENAI_DEPENDENCY, outcome, probeToken);
          } catch {
            span.setAttribute("northstar.llm.breaker_report_failed", true);
          }
        };
        span.setAttributes({
          "northstar.llm.route": EMBED_ROUTE,
          "northstar.llm.model": EMBED_MODEL,
          "northstar.llm.inputs": texts.length,
        });
        try {
          // Checked before anything is asked, so a bad batch never takes a breaker probe.
          if (texts.length === 0 || texts.length > MAX_EMBED_INPUTS) {
            throw new RangeError(`embed takes 1 to ${MAX_EMBED_INPUTS} texts`);
          }
          if (texts.some((t) => t.trim() === "" || t.length > MAX_EMBED_CHARS)) {
            throw new RangeError(`each text must be 1 to ${MAX_EMBED_CHARS} characters`);
          }
          // The spend cap first: a held-back call takes no probe. A meter that throws holds the
          // call back (fail safe), as the chat gateway does.
          if (deps.budget) {
            const { caps, meter } = deps.budget;
            if (caps.dailyUsd !== null || caps.monthlyUsd !== null) {
              let cap: string | null;
              try {
                cap = (await flush(meter))
                  ? budgetHold(await meter.spent(), caps, EMBED_PRIORITY)
                  : "unrecorded";
              } catch (error) {
                cap = "unknown";
                span.setAttribute(
                  "northstar.llm.guard_error",
                  error instanceof Error ? error.name : "UnknownError",
                );
              }
              if (cap !== null) {
                span.setAttribute("northstar.llm.held_by", "budget");
                throw new HeldBack("budget", cap);
              }
            }
          }
          if (deps.guard) {
            const admission = await admit(deps.guard, {
              subsystem: `agent:${EMBED_ROUTE}`,
              dependency: OPENAI_DEPENDENCY,
            });
            if (!admission.ok) {
              span.setAttribute("northstar.llm.held_by", admission.held.by);
              if (admission.errorName !== null) {
                span.setAttribute("northstar.llm.guard_error", admission.errorName);
              }
              throw admission.held;
            }
            probeToken = admission.probeToken;
          }
          let response: Response;
          try {
            response = await send(EMBED_URL, {
              method: "POST",
              headers: {
                authorization: `Bearer ${deps.apiKey}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model: EMBED_MODEL,
                input: texts,
                dimensions: EMBED_DIMENSIONS,
                encoding_format: "float",
              }),
              // A redirect would send the key's request somewhere else: never followed.
              redirect: "error",
              signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
            });
          } catch {
            // No answer (a dropped connection, a timeout, a refused redirect): the API's trouble.
            await report({ ok: false, error: "EmbedTransportError" });
            throw new EmbedTransportError(null, true);
          }
          span.setAttribute("http.response.status_code", response.status);
          if (!response.ok) {
            const retryable = isRetryableStatus(response.status);
            // Only the API's own trouble counts against it: a 400 or 401 means it answered.
            await report(retryable ? { ok: false, error: "EmbedTransportError" } : { ok: true });
            throw new EmbedTransportError(response.status, retryable);
          }
          await report({ ok: true });
          const parsed = Reply.safeParse(await response.json().catch(() => null));
          if (!parsed.success) throw new EmbedResponseError("embeddings reply has the wrong shape");
          const reply = parsed.data;
          const usd = reply.usage.prompt_tokens * EMBED_USD_PER_TOKEN;
          span.setAttributes({
            "northstar.llm.input_tokens": reply.usage.prompt_tokens,
            "northstar.llm.cost_usd": usd,
          });
          // Billed whatever comes next, so recorded before the reply is checked further.
          if (deps.budget) {
            try {
              await deps.budget.meter.record(EMBED_ROUTE, usd);
            } catch {
              unrecorded.push(usd);
              span.setAttribute("northstar.llm.spend_record_failed", true);
            }
          }
          // One vector per text, each index once: anything else is never guessed into order.
          const vectors: (number[] | undefined)[] = new Array(texts.length).fill(undefined);
          for (const item of reply.data) {
            if (item.index >= texts.length || vectors[item.index] !== undefined) {
              throw new EmbedResponseError("embeddings reply has a bad index");
            }
            vectors[item.index] = item.embedding;
          }
          if (vectors.some((v) => v === undefined)) {
            throw new EmbedResponseError("embeddings reply is missing a vector");
          }
          span.setAttribute("northstar.llm.outcome", "Ok");
          return vectors as number[][];
        } catch (error) {
          // The kind only: a message could quote the request.
          const kind = error instanceof Error ? error.name : "UnknownError";
          span.setAttribute("northstar.llm.outcome", kind);
          span.setStatus({ code: SpanStatusCode.ERROR, message: kind });
          throw error;
        } finally {
          span.end();
        }
      });
    },
  };
}
