import type { LlmGateway, Route } from "@northstar/llm";
import { untrustedBlock } from "@northstar/llm";
import { loadPrompt } from "@northstar/prompts";
import { z } from "zod";
import type { CandidatePick } from "./catcher.js";

// The verification-extract route (NS-149, VER-003): the model fallback for a verification mail
// with several candidate codes or links. It only chooses among the candidates plain code already
// found: its output is an index, never a code or link, so nothing secret is ever in its output,
// the call record or a fixture's response (VER-005). The catcher checks whatever it chooses.
// Off by default until Paul records real fixtures (ADR-0016 item 8).

export const VERIFICATION_EXTRACT_VERSION = 1;

// The body the route sees: a verification mail is short; anything longer is cut and marked.
export const BODY_LIMIT = 8_000;

export type VerificationExtractInput = {
  body: string;
  kind: "code" | "link";
  candidates: string[];
};

export const VerificationChoice = z
  .object({
    // The index of the candidate this email asks the person to use, or null.
    choice: z.number().int().nullable(),
  })
  .strict();
export type VerificationChoice = z.infer<typeof VerificationChoice>;

export function renderCandidates(input: VerificationExtractInput): string {
  const label = input.kind === "code" ? "Codes" : "Links";
  return [`${label}:`, ...input.candidates.map((c, i) => `[${i}] ${c}`)].join("\n");
}

export function renderBody(body: string): string {
  return body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}\n[cut]` : body;
}

// No tools. The body is an email (untrusted, NFR-SEC-004); the candidates come from that same
// email, so they are untrusted too.
export function verificationExtractRoute(): Route<VerificationExtractInput, VerificationChoice> {
  const prompt = loadPrompt("verification-extract", VERIFICATION_EXTRACT_VERSION);
  return {
    name: "verification-extract",
    prompt,
    // Picking one of a few strings from a short email: low effort, with the eval as the check.
    effort: "low",
    maxTokens: 500,
    timeoutMs: 30_000,
    output: VerificationChoice,
    render: (input) => ({
      stable: [],
      volatile: [
        untrustedBlock("email", renderBody(input.body)),
        untrustedBlock("candidates", renderCandidates(input)),
      ].join("\n\n"),
    }),
  };
}

// A CandidatePick backed by the route. Off (null, no call) unless `enabled` is true. Every
// outcome other than a clean choice is null, which the catcher turns into needs_human. A
// transport error throws; the catcher treats a throwing pick the same way.
export function modelPick(deps: { gateway: LlmGateway; enabled?: boolean }): CandidatePick {
  return async (input) => {
    if (deps.enabled !== true || input.candidates.length < 2) return null;
    const outcome = await deps.gateway.call(verificationExtractRoute(), input);
    switch (outcome.kind) {
      case "Ok":
        return outcome.output.choice;
      case "Refused":
      case "Truncated":
      case "InvalidOutput":
        return null;
    }
  };
}
