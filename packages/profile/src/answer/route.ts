import type { Route } from "@northstar/llm";
import { untrustedBlock } from "@northstar/llm";
import { loadPrompt } from "@northstar/prompts";
import type { EvidenceItem } from "./evidence.js";
import { AnswerDraft } from "./schema.js";

export const ANSWER_DRAFT_VERSION = 3;

export type AnswerDraftInput = {
  question: string;
  // The most characters the form accepts, or null when it sets none.
  limit: number | null;
  // How Paul writes (ANS-007, NS-136). Empty until the voice profile exists.
  voiceGuide: string;
  evidence: EvidenceItem[];
};

// The evidence as one block: each item on its own line with its id and kind, so a quote can be
// checked against the item it cites.
export function renderEvidence(evidence: readonly EvidenceItem[]): string {
  return evidence.map((e) => `[${e.id}] (${e.kind}) ${e.text}`).join("\n");
}

// The answer-draft route (ANS-004, NS-135): a form question and Paul's stories and atoms in, an
// answer whose every sentence cites them out. Every block is untrusted: the question comes from
// an employer's page, and stories hold text Paul typed or pasted. No tools.
export function answerDraftRoute(): Route<AnswerDraftInput, AnswerDraft> {
  const prompt = loadPrompt("answer-draft", ANSWER_DRAFT_VERSION);
  return {
    name: "answer-draft",
    prompt,
    // Keep-his-words drafting from given material: medium, with the eval as the check (ADR-0006).
    effort: "medium",
    // Three to six cited sentences.
    maxTokens: 8_000,
    timeoutMs: 120_000,
    output: AnswerDraft,
    render: ({ question, limit, voiceGuide, evidence }) => ({
      stable: [],
      volatile: [
        untrustedBlock("question", question),
        untrustedBlock("limit", limit === null ? "none" : String(limit)),
        untrustedBlock("voice", voiceGuide),
        untrustedBlock("evidence", renderEvidence(evidence)),
      ].join("\n\n"),
    }),
  };
}
