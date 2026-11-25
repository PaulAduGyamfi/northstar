import type { CallRecord, LlmGateway, LlmOutcome } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import { draftAnswer } from "./draft.js";
import type { EvidenceItem } from "./evidence.js";
import type { AnswerDraftInput } from "./route.js";
import type { AnswerDraft } from "./schema.js";

// Synthetic evidence (the repo is public).
const STORY: EvidenceItem = {
  id: "story-1",
  kind: "story",
  text: "Pushing back the card launch. The fraud checks weren't finished. We agreed to launch one week later.",
};
const UNRELATED: EvidenceItem = { id: "atom-9", kind: "atom", text: "Wrote the on-call runbook." };
const QUESTION = "Tell us about a time you pushed back on a launch.";

const record: CallRecord = {
  route: "answer-draft",
  promptId: "answer-draft",
  promptVersion: 1,
  modelRequested: "claude-opus-5-5",
  modelServed: "claude-opus-5-5",
  effort: "medium",
  inputTokens: 700,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  latencyMs: 2000,
  costUsd: 0.008,
  stopReason: "end_turn",
  refusalCategory: null,
  fallbackUsed: false,
};

const good: AnswerDraft = {
  sentences: [
    {
      text: "The fraud checks weren't finished, so we agreed to launch one week later.",
      cites: [
        { id: "story-1", quote: "The fraud checks weren't finished." },
        { id: "story-1", quote: "We agreed to launch one week later." },
      ],
    },
  ],
  followUps: [],
};

// A gateway that answers with one outcome and keeps each input, or refuses to be called.
function gatewayAnswering(outcome: LlmOutcome<AnswerDraft> | null) {
  const inputs: AnswerDraftInput[] = [];
  const gateway: LlmGateway = {
    async call<I, O>(_route: unknown, input: I): Promise<LlmOutcome<O>> {
      inputs.push(input as unknown as AnswerDraftInput);
      if (!outcome) throw new Error("unexpected model call");
      return outcome as unknown as LlmOutcome<O>;
    },
  };
  return { gateway, inputs };
}

const request = { question: QUESTION, limit: null, voiceGuide: "", items: [UNRELATED, STORY] };

describe("draftAnswer", () => {
  it("is off by default: it calls nothing and says so", async () => {
    const { gateway } = gatewayAnswering(null);
    expect(await draftAnswer({ gateway }, request)).toEqual({ kind: "off" });
  });

  it("sends only the evidence that matches the question", async () => {
    const { gateway, inputs } = gatewayAnswering({ kind: "Ok", output: good, record });
    await draftAnswer({ gateway, enabled: true }, request);
    expect(inputs.map((i) => i.evidence.map((e) => e.id))).toEqual([["story-1"]]);
  });

  it("returns a draft that passes the provenance check, with its call record", async () => {
    const { gateway } = gatewayAnswering({ kind: "Ok", output: good, record });
    expect(await draftAnswer({ gateway, enabled: true }, request)).toEqual({
      kind: "drafted",
      draft: good,
      evidence: ["story-1"],
      record,
    });
  });

  it("never returns a draft that fails the check: it needs Paul instead", async () => {
    const bad: AnswerDraft = {
      sentences: [{ text: "We launched 2 weeks later.", cites: good.sentences[0]?.cites ?? [] }],
      followUps: [],
    };
    const { gateway } = gatewayAnswering({ kind: "Ok", output: bad, record });
    expect(await draftAnswer({ gateway, enabled: true }, request)).toEqual({
      kind: "needs_human",
      reason: "provenance",
      failures: [{ sentence: 0, problem: "number at word 2 is not in its quotes" }],
      record,
    });
  });

  it("needs Paul when the model refuses", async () => {
    const { gateway } = gatewayAnswering({ kind: "Refused", category: null, record });
    expect(await draftAnswer({ gateway, enabled: true }, request)).toEqual({
      kind: "needs_human",
      reason: "refused",
      failures: [],
      record,
    });
  });

  it("needs Paul without a model call when no evidence matches the question", async () => {
    const { gateway } = gatewayAnswering(null);
    const thin = { ...request, items: [UNRELATED] };
    expect(await draftAnswer({ gateway, enabled: true }, thin)).toEqual({
      kind: "needs_human",
      reason: "no_evidence",
      failures: [],
      record: null,
    });
  });
});
