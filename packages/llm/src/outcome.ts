import { costUsd } from "./pricing.js";
import { DEFAULT_MODEL, type Route } from "./route.js";
import type { BetaMessage } from "./sdk-types.js";

// What one call cost and did (OBV-003, NFR-AIQ-003). Ids, versions and numbers only, never text.
export type CallRecord = {
  route: string;
  promptId: string;
  promptVersion: number;
  modelRequested: string;
  // Differs from modelRequested when a server-side fallback model answered.
  modelServed: string;
  effort: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  // null when the served model has no known price (pricing.ts).
  costUsd: number | null;
  stopReason: string | null;
  refusalCategory: string | null;
  fallbackUsed: boolean;
};

// Expected model outcomes are values the caller must handle; only transport failures throw.
export type LlmOutcome<O> =
  | { kind: "Ok"; output: O; record: CallRecord }
  | { kind: "Refused"; category: string | null; record: CallRecord }
  | { kind: "Truncated"; record: CallRecord }
  | {
      kind: "InvalidOutput";
      // not_json: unparsable; schema: parsed but wrong shape; stop_reason: an unexpected stop.
      reason: "not_json" | "schema" | "stop_reason";
      // Paths of the failing fields, never their values (they may echo untrusted text).
      fields: string[];
      record: CallRecord;
    };

export function callRecord<I, O>(
  route: Route<I, O>,
  message: BetaMessage,
  latencyMs: number,
): CallRecord {
  const usage = message.usage;
  const tokens = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
  return {
    route: route.name,
    promptId: route.prompt.id,
    promptVersion: route.prompt.version,
    modelRequested: route.model ?? DEFAULT_MODEL,
    modelServed: message.model,
    effort: route.effort,
    ...tokens,
    latencyMs,
    // Priced at the model that answered. A fallback reply is priced entirely at the fallback
    // model's rates; the declined attempt's share isn't split out (good enough for metering).
    costUsd: costUsd(message.model, tokens),
    stopReason: message.stop_reason,
    refusalCategory: message.stop_details?.category ?? null,
    // The API marks a fallback-served reply with a fallback_message usage iteration.
    fallbackUsed: (usage.iterations ?? []).some((entry) => entry.type === "fallback_message"),
  };
}

// Reads a reply in the only safe order: stop reason first, then content, then the schema.
export function interpretMessage<I, O>(
  route: Route<I, O>,
  message: BetaMessage,
  record: CallRecord,
): LlmOutcome<O> {
  if (message.stop_reason === "refusal") {
    return { kind: "Refused", category: record.refusalCategory, record };
  }
  if (message.stop_reason === "max_tokens") {
    return { kind: "Truncated", record };
  }
  if (message.stop_reason !== "end_turn") {
    return { kind: "InvalidOutput", reason: "stop_reason", fields: [], record };
  }

  // Structured output arrives as JSON text in the text blocks.
  const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "InvalidOutput", reason: "not_json", fields: [], record };
  }

  const parsed = route.output.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    return { kind: "InvalidOutput", reason: "schema", fields, record };
  }
  return { kind: "Ok", output: parsed.data, record };
}
