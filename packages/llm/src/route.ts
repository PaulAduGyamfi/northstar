import type { z } from "zod";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// ADR-0006: one default model. A cheaper tier needs an eval and an ADR amendment.
export const DEFAULT_MODEL = "claude-opus-5-5";

// Everything the gateway needs to know about one kind of model call.
export type Route<Input, Output> = {
  // kebab-case, also the eval folder name (evals/<name>).
  name: string;
  // Versioned prompt. A changed prompt gets a new version, never an edit (llm.md).
  prompt: { id: string; version: number; text: string };
  model?: string;
  // Required: Opus 5.5 defaults to medium, so every route chooses deliberately (ADR-0006).
  effort: Effort;
  maxTokens: number;
  // Per-attempt timeout (RES-005). The SDK retries 408/409/429/5xx up to twice, each attempt
  // with this timeout, so the worst case is about 3 × timeoutMs plus backoff.
  timeoutMs: number;
  // Checked again on arrival; the JSON schema sent to the API is made from it.
  output: z.ZodType<Output>;
  // `stable` blocks are cached and must not vary per call. `volatile` is the per-call request,
  // with untrusted text wrapped by untrustedBlock().
  render(input: Input): { stable: string[]; volatile: string };
};
