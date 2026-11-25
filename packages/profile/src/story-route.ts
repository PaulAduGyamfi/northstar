import type { Route } from "@northstar/llm";
import { untrustedBlock } from "@northstar/llm";
import { loadPrompt } from "@northstar/prompts";
import { StoryDraft } from "./story-schema.js";

export const STORY_DRAFT_VERSION = 1;

export type StoryDraftInput = {
  atom: { id: string; what: string; sourceQuote: string };
  answers: { question: string; answer: string }[];
};

// The answers as one block of text: each question, then Paul's answer. Skipped questions (an
// empty answer) are left out, so the model doesn't read silence as a claim.
export function renderAnswers(answers: StoryDraftInput["answers"]): string {
  return answers
    .filter((a) => a.answer.trim() !== "")
    .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
    .join("\n\n");
}

// The story-draft route (NS-111): one atom and Paul's interview answers in, a STAR story with
// quotes out. Both are per-call text, inside untrusted blocks: Paul may paste text from elsewhere,
// and a line in it must not act as an instruction.
export function storyDraftRoute(): Route<StoryDraftInput, StoryDraft> {
  const prompt = loadPrompt("story-draft", STORY_DRAFT_VERSION);
  return {
    name: "story-draft",
    prompt,
    // Keep-his-words editing, not open judgment: medium, with the eval as the check (ADR-0006).
    effort: "medium",
    // Four short parts with their quotes; truncation is reported, never stored.
    maxTokens: 8_000,
    timeoutMs: 120_000,
    output: StoryDraft,
    render: ({ atom, answers }) => ({
      stable: [],
      volatile: [
        untrustedBlock(
          "atom",
          `id: ${atom.id}\nwhat: ${atom.what}\nresume line: ${atom.sourceQuote}`,
        ),
        untrustedBlock("answers", renderAnswers(answers)),
      ].join("\n\n"),
    }),
  };
}
