import type { CallRecord, LlmGateway, LlmOutcome } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import {
  modelPick,
  type VerificationChoice,
  type VerificationExtractInput,
  verificationExtractRoute,
} from "./model-pick.js";

// Placeholder codes and example.com links only (VER-005: the repo is public).

const input: VerificationExtractInput = {
  body: "Your new code is 111111. The code 222222 we sent earlier has expired.",
  kind: "code",
  candidates: ["111111", "222222"],
};

const record: CallRecord = {
  route: "verification-extract",
  promptId: "verification-extract",
  promptVersion: 1,
  modelRequested: "claude-opus-5-5",
  modelServed: "claude-opus-5-5",
  effort: "low",
  inputTokens: 300,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  latencyMs: 900,
  costUsd: 0.002,
  stopReason: "end_turn",
  refusalCategory: null,
  fallbackUsed: false,
};

function gatewayAnswering(outcome: LlmOutcome<VerificationChoice> | null) {
  const inputs: VerificationExtractInput[] = [];
  const gateway: LlmGateway = {
    async call<I, O>(_route: unknown, i: I): Promise<LlmOutcome<O>> {
      inputs.push(i as unknown as VerificationExtractInput);
      if (!outcome) throw new Error("unexpected model call");
      return outcome as unknown as LlmOutcome<O>;
    },
  };
  return { gateway, inputs };
}

describe("modelPick", () => {
  it("is off by default: null, and no model call", async () => {
    const { gateway, inputs } = gatewayAnswering(null);
    expect([await modelPick({ gateway })(input), inputs.length]).toEqual([null, 0]);
  });

  it("makes no call for fewer than two candidates", async () => {
    const { gateway, inputs } = gatewayAnswering(null);
    const pick = modelPick({ gateway, enabled: true });
    expect([await pick({ ...input, candidates: ["111111"] }), inputs.length]).toEqual([null, 0]);
  });

  it("returns the model's index when on", async () => {
    const { gateway } = gatewayAnswering({ kind: "Ok", output: { choice: 0 }, record });
    expect(await modelPick({ gateway, enabled: true })(input)).toBe(0);
  });

  it.each([
    { kind: "Refused", category: null, record },
    { kind: "Truncated", record },
    { kind: "InvalidOutput", issues: [], record },
  ])("returns null for a $kind outcome", async (outcome) => {
    const { gateway } = gatewayAnswering(outcome as unknown as LlmOutcome<VerificationChoice>);
    expect(await modelPick({ gateway, enabled: true })(input)).toBeNull();
  });
});

describe("verificationExtractRoute", () => {
  it("puts the email and the candidates in untrusted blocks, nothing in the stable part", () => {
    const rendered = verificationExtractRoute().render(input);
    expect([
      rendered.stable,
      rendered.volatile.includes('<untrusted_data kind="email">'),
      rendered.volatile.includes('<untrusted_data kind="candidates">'),
      rendered.volatile.includes("[1] 222222"),
    ]).toEqual([[], true, true, true]);
  });

  it("cuts a long body and marks it", () => {
    const rendered = verificationExtractRoute().render({ ...input, body: "x".repeat(9_000) });
    expect(rendered.volatile.includes("[cut]")).toBe(true);
  });

  it("can only answer with an index, never a code or link", () => {
    const schema = verificationExtractRoute().output;
    expect([
      schema.safeParse({ choice: 1 }).success,
      schema.safeParse({ choice: null }).success,
      schema.safeParse({ choice: "111111" }).success,
      schema.safeParse({ choice: 0, code: "111111" }).success,
    ]).toEqual([true, true, false, false]);
  });
});
