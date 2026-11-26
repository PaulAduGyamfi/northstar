import type { CallRecord, LlmGateway, LlmOutcome } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "../answer/evidence.js";
import { draftReply } from "./draft.js";
import type { ReplyDraftInput } from "./route.js";
import type { ReplyDraft } from "./schema.js";

// Synthetic email and evidence only (the repo is public).
const EMAIL =
  "Hi Paul, I'm Dana, a recruiter at Initech. Could you tell me about your payments work?";
const ATOM: EvidenceItem = {
  id: "atom-1",
  kind: "atom",
  text: "Built the card payments flow at Globex.",
};
const UNRELATED: EvidenceItem = { id: "atom-9", kind: "atom", text: "Wrote the on-call runbook." };

const record: CallRecord = {
  route: "reply-draft",
  promptId: "reply-draft",
  promptVersion: 1,
  modelRequested: "claude-opus-5-5",
  modelServed: "claude-opus-5-5",
  effort: "medium",
  inputTokens: 600,
  outputTokens: 150,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  latencyMs: 1500,
  costUsd: 0.006,
  stopReason: "end_turn",
  refusalCategory: null,
  fallbackUsed: false,
};

const good: ReplyDraft = {
  sentences: [
    { text: "Hi Dana, thanks for reaching out.", cites: [] },
    {
      text: "I built the card payments flow at Globex.",
      cites: [{ id: "atom-1", quote: "Built the card payments flow at Globex." }],
    },
  ],
  followUps: [],
};

// A gateway that answers with one outcome and keeps each input, or refuses to be called.
function gatewayAnswering(outcome: LlmOutcome<ReplyDraft> | null) {
  const inputs: ReplyDraftInput[] = [];
  const gateway: LlmGateway = {
    async call<I, O>(_route: unknown, input: I): Promise<LlmOutcome<O>> {
      inputs.push(input as unknown as ReplyDraftInput);
      if (!outcome) throw new Error("unexpected model call");
      return outcome as unknown as LlmOutcome<O>;
    },
  };
  return { gateway, inputs };
}

const request = {
  kind: "recruiter_inbound",
  email: EMAIL,
  senderName: "Dana Reyes",
  voiceGuide: "",
  items: [ATOM, UNRELATED],
};

describe("draftReply", () => {
  it("is off unless the caller turns it on, and calls no model", async () => {
    const { gateway } = gatewayAnswering(null);
    expect(await draftReply({ gateway }, request)).toEqual({ kind: "off" });
  });

  it("drafts nothing for a rejection, and calls no model", async () => {
    const { gateway } = gatewayAnswering(null);
    expect(await draftReply({ gateway, enabled: true }, { ...request, kind: "rejection" })).toEqual(
      { kind: "none" },
    );
  });

  it("returns a draft that passes the check, with the evidence it was given", async () => {
    const { gateway, inputs } = gatewayAnswering({ kind: "Ok", output: good, record });
    expect(await draftReply({ gateway, enabled: true }, request)).toEqual({
      kind: "drafted",
      draft: good,
      evidence: ["atom-1"],
      record,
    });
    expect(inputs.map((i) => [i.need, i.sender, i.evidence.map((e) => e.id)])).toEqual([
      ["reply", "Dana", ["atom-1"]],
    ]);
  });

  it("asks for a reply without times on an interview request", async () => {
    const { gateway, inputs } = gatewayAnswering({ kind: "Ok", output: good, record });
    await draftReply({ gateway, enabled: true }, { ...request, kind: "interview_request" });
    expect(inputs.map((i) => i.need)).toEqual(["reply_without_times"]);
  });

  it("shows the route at most 8,000 characters of the email", async () => {
    const { gateway, inputs } = gatewayAnswering({ kind: "Ok", output: good, record });
    await draftReply({ gateway, enabled: true }, { ...request, email: EMAIL + "x".repeat(9_000) });
    expect(inputs.map((i) => i.email.length)).toEqual([8_000]);
  });

  it("hands Paul a draft with an invented claim, naming the sentence and not the text", async () => {
    const bad: ReplyDraft = {
      ...good,
      sentences: [
        good.sentences[0] as ReplyDraft["sentences"][number],
        {
          ...(good.sentences[1] as ReplyDraft["sentences"][number]),
          text: "I led payments at Hooli.",
        },
      ],
    };
    const { gateway } = gatewayAnswering({ kind: "Ok", output: bad, record });
    expect(await draftReply({ gateway, enabled: true }, request)).toEqual({
      kind: "needs_human",
      reason: "provenance",
      failures: [{ sentence: 1, problem: "name at word 4 is not in its cited items" }],
      record,
    });
  });

  it("hands Paul a draft that keeps a phrase he deleted three times", async () => {
    const { gateway } = gatewayAnswering({ kind: "Ok", output: good, record });
    expect(
      await draftReply(
        { gateway, enabled: true },
        { ...request, avoid: ["thanks for reaching out"] },
      ),
    ).toEqual({
      kind: "needs_human",
      reason: "voice",
      failures: [{ sentence: null, problem: "avoided phrase 0 is in the draft" }],
      record,
    });
  });

  it("hands Paul a refusal with its call record", async () => {
    const { gateway } = gatewayAnswering({
      kind: "Refused",
      category: null,
      record,
    } as LlmOutcome<ReplyDraft>);
    expect(await draftReply({ gateway, enabled: true }, request)).toEqual({
      kind: "needs_human",
      reason: "refused",
      failures: [],
      record,
    });
  });
});
