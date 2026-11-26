import type { CallRecord, LlmGateway, LlmOutcome } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import { extractRecruiterFacts } from "./extract.js";
import type { RecruiterExtractInput } from "./route.js";
import type { RecruiterFacts } from "./schema.js";

// Synthetic email and facts only.
const EMAIL = "Hi Paul, I'm Dana at Initech. We're hiring a Staff Engineer, remote.";
const record: CallRecord = {
  route: "recruiter-extract",
  promptId: "recruiter-extract",
  promptVersion: 1,
  modelRequested: "claude-opus-5-5",
  modelServed: "claude-opus-5-5",
  effort: "low",
  inputTokens: 300,
  outputTokens: 120,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  latencyMs: 900,
  costUsd: 0.002,
  stopReason: "end_turn",
  refusalCategory: null,
  fallbackUsed: false,
};
const facts: RecruiterFacts = {
  roleTitle: "Staff Engineer",
  seniority: "Staff",
  company: "Initech",
  location: null,
  remote: "remote",
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: null,
  salaryPeriod: null,
  agency: false,
  personalizedQuote: null,
  redFlags: [],
};

function gatewayAnswering(outcome: LlmOutcome<RecruiterFacts> | null) {
  const inputs: RecruiterExtractInput[] = [];
  const gateway: LlmGateway = {
    async call<I, O>(_route: unknown, input: I): Promise<LlmOutcome<O>> {
      inputs.push(input as unknown as RecruiterExtractInput);
      if (!outcome) throw new Error("unexpected model call");
      return outcome as unknown as LlmOutcome<O>;
    },
  };
  return { gateway, inputs };
}

describe("extractRecruiterFacts", () => {
  it("is off unless the caller turns it on, and calls no model", async () => {
    expect(await extractRecruiterFacts({ gateway: gatewayAnswering(null).gateway }, EMAIL)).toEqual(
      { kind: "off" },
    );
  });

  it("returns the checked facts, with what it dropped", async () => {
    const { gateway } = gatewayAnswering({
      kind: "Ok",
      output: { ...facts, location: "Berlin" },
      record,
    });
    expect(await extractRecruiterFacts({ gateway, enabled: true }, EMAIL)).toEqual({
      kind: "extracted",
      facts,
      dropped: ["location"],
      record,
    });
  });

  it("shows the route at most 8,000 characters of the email", async () => {
    const { gateway, inputs } = gatewayAnswering({ kind: "Ok", output: facts, record });
    await extractRecruiterFacts({ gateway, enabled: true }, EMAIL + "x".repeat(9_000));
    expect(inputs.map((i) => i.email.length)).toEqual([8_000]);
  });

  it("hands Paul a refusal with its call record", async () => {
    const { gateway } = gatewayAnswering({ kind: "Refused", category: null, record });
    expect(await extractRecruiterFacts({ gateway, enabled: true }, EMAIL)).toEqual({
      kind: "needs_human",
      reason: "refused",
      record,
    });
  });
});
