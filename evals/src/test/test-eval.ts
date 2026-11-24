import type { CallRecord, LlmGateway, LlmOutcome, MessagesClient, Route } from "@northstar/llm";
import { untrustedBlock } from "@northstar/llm";
import { z } from "zod";
import { fieldsSubset } from "../graders.js";
import { defineEval } from "../types.js";

// A route and eval set that exist only for tests (no production route exists yet).
const Output = z.object({ label: z.enum(["remote", "onsite"]), confidence: z.number() });
type Output = z.infer<typeof Output>;
type Input = { jobText: string };

export const testRoute: Route<Input, Output> = {
  name: "test-classify",
  prompt: { id: "test-classify", version: 1, text: "You label job snippets as remote or onsite." },
  effort: "low",
  maxTokens: 1024,
  timeoutMs: 30_000,
  output: Output,
  render: (input) => ({ stable: [], volatile: untrustedBlock("job_page", input.jobText) }),
};

export const testEval = defineEval({
  route: testRoute,
  inputSchema: z.object({ jobText: z.string() }),
  expectedSchema: z.object({ label: z.enum(["remote", "onsite"]) }),
  grader: fieldsSubset,
});

// Synthetic cases: two remote, one onsite.
export const testCases = [
  {
    id: "remote-1",
    input: { jobText: "Fully remote role at Example Corp." },
    expected: { label: "remote" },
  },
  {
    id: "remote-2",
    input: { jobText: "Work from anywhere, Example Inc." },
    expected: { label: "remote" },
  },
  {
    id: "onsite-1",
    input: { jobText: "Onsite five days in Example City." },
    expected: { label: "onsite" },
  },
] as const;

const record: CallRecord = {
  route: "test-classify",
  promptId: "test-classify",
  promptVersion: 1,
  modelRequested: "claude-opus-5-5",
  modelServed: "claude-opus-5-5",
  effort: "low",
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  latencyMs: 5,
  costUsd: 0.0006,
  stopReason: "end_turn",
  refusalCategory: null,
  fallbackUsed: false,
};

// A gateway that labels everything "remote", so it gets the onsite case wrong.
export const alwaysRemoteGateway: LlmGateway = {
  async call<_I, O>(): Promise<LlmOutcome<O>> {
    return {
      kind: "Ok",
      output: { label: "remote", confidence: 0.8 } as O,
      record,
    } as LlmOutcome<O>;
  },
};

// A Messages client answering every request with a synthetic reply labeled `label`.
export function messagesAnswering(label: "remote" | "onsite"): MessagesClient {
  return {
    async create() {
      return {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [
          { type: "text", text: JSON.stringify({ label, confidence: 0.9 }), citations: null },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        stop_details: null,
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          iterations: null,
        },
      } as unknown as Awaited<ReturnType<MessagesClient["create"]>>;
    },
  };
}
