import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { DEFAULT_MODEL, type Route } from "./route.js";
import type { MessageCreateParams, RequestOptions } from "./sdk-types.js";

// Opus 5.5 declines some requests; the API then retries on a fallback model it picks by
// refusal category (ADR-0006 "enable server-side fallbacks").
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

// Builds the exact request for one call. Pure and deterministic: the same input gives the same
// bytes, which prompt caching and fixture keys both depend on (ADR-0013).
export function buildRequest<I, O>(
  route: Route<I, O>,
  input: I,
): { params: MessageCreateParams; options: RequestOptions } {
  const { stable, volatile } = route.render(input);
  // Stable first: the prompt, then each stable context block (llm.md caching order).
  const systemTexts = [route.prompt.text, ...stable];
  const lastIndex = systemTexts.length - 1;
  // Keep only the JSON schema; the gateway validates the reply with the Zod schema itself.
  const { type, schema } = betaZodOutputFormat(route.output);

  const params: MessageCreateParams = {
    model: route.model ?? DEFAULT_MODEL,
    max_tokens: route.maxTokens,
    thinking: { type: "adaptive" },
    output_config: { effort: route.effort, format: { type, schema } },
    // One breakpoint, on the last stable block: everything before it is reused across calls.
    system: systemTexts.map((text, index) =>
      index === lastIndex
        ? { type: "text", text, cache_control: { type: "ephemeral" } }
        : { type: "text", text },
    ),
    messages: [{ role: "user", content: volatile }],
    betas: [FALLBACK_BETA],
    fallbacks: "default",
  };
  return { params, options: { timeout: route.timeoutMs } };
}
