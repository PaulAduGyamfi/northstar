import type { LlmGateway, Route } from "@northstar/llm";
import { untrustedBlock } from "@northstar/llm";
import { loadPrompt } from "@northstar/prompts";
import { z } from "zod";
import type { CanonicalQuestion } from "./question-canon.js";
import { matchQuestion, NEGATION, type QuestionMatch, rankCanonical } from "./question-match.js";
import { normalize } from "./validate.js";

// The question-confirm route (NS-137, ANS-002): a model confirm step for questions the lexical
// matcher left as new because they scored low or tied. Decided on #62: no embedding provider.
// The model only picks among catalog questions code already found close, by index, or says none;
// code checks the index. Off by default until Paul records real fixtures (ADR-0016 item 8).

export const QUESTION_CONFIRM_VERSION = 1;

// A candidate must score at least this lexically: below it, the catalog question shares too
// little with the form's question for a confirm to be worth a call. A guess, to tune with Paul's
// private labelled set.
export const CONFIRM_FLOOR = 0.4;
// The most candidates the model sees.
export const MAX_CONFIRM_CANDIDATES = 3;
// A form question is one sentence or two; anything longer is cut and marked.
export const QUESTION_LIMIT = 1_000;

export type QuestionConfirmInput = {
  question: string;
  // Catalog wordings (trusted): the canonical text of each candidate, best lexical score first.
  candidates: string[];
};

export const QuestionChoice = z
  .object({
    // The index of the candidate that asks for the same answer, or null.
    choice: z.number().int().nullable(),
  })
  .strict();
export type QuestionChoice = z.infer<typeof QuestionChoice>;

// The canonical questions the model may choose from. Never a factual one: a factual match fills
// an answer from Paul's settings without drafting, so it stays with code's stricter threshold.
export function confirmCandidates(question: string): CanonicalQuestion[] {
  return candidatesFrom(rankCanonical(question)).map((r) => r.canonical);
}

function candidatesFrom(
  ranked: ReturnType<typeof rankCanonical>,
): ReturnType<typeof rankCanonical> {
  return ranked
    .filter((r) => r.canonical.kind !== "factual" && r.score >= CONFIRM_FLOOR)
    .slice(0, MAX_CONFIRM_CANDIDATES);
}

export function renderQuestionCandidates(candidates: readonly string[]): string {
  return ["<candidates>", ...candidates.map((c, i) => `[${i}] ${c}`), "</candidates>"].join("\n");
}

const renderQuestion = (q: string) =>
  q.length > QUESTION_LIMIT ? `${q.slice(0, QUESTION_LIMIT)}\n[cut]` : q;

// No tools. The question comes from an employer's form (untrusted, NFR-SEC-004); the candidates
// are the catalog's own text.
export function questionConfirmRoute(): Route<QuestionConfirmInput, QuestionChoice> {
  const prompt = loadPrompt("question-confirm", QUESTION_CONFIRM_VERSION);
  return {
    name: "question-confirm",
    prompt,
    // Picking one of three short questions: low effort, with the eval as the check.
    effort: "low",
    maxTokens: 300,
    timeoutMs: 30_000,
    // Part of assembling a package, not on the fresh-posting path (ADR-0021).
    priority: "normal",
    output: QuestionChoice,
    render: (input) => ({
      stable: [],
      volatile: [
        untrustedBlock("question", renderQuestion(input.question)),
        renderQuestionCandidates(input.candidates),
      ].join("\n\n"),
    }),
  };
}

export type ConfirmedMatch = { match: QuestionMatch; by: "rules" | "model" };

// The lexical match, confirmed by the model where it left a close question as new. Only a choice
// that indexes one of the candidates counts; every other outcome keeps the lexical result, which
// treats the question as new (drafted fresh: the safe side). A transport error or HeldBack
// throws, so the caller retries.
export async function confirmQuestion(
  deps: { gateway: LlmGateway; enabled?: boolean },
  question: string,
): Promise<ConfirmedMatch> {
  const match = matchQuestion(question);
  const rules: ConfirmedMatch = { match, by: "rules" };
  // A match, an empty question and a negated factual one are code's to decide.
  if (
    match.status === "matched" ||
    (match.reason !== "below_threshold" && match.reason !== "ambiguous")
  ) {
    return rules;
  }
  // A negated question ("Why would you NOT want to work here?") asks the opposite of any
  // catalog question it resembles.
  if (NEGATION.test(normalize(question))) return rules;
  if (deps.enabled !== true) return rules;
  const ranked = rankCanonical(question);
  // Closest to a factual question ("Are you authorized to work here and do you need
  // sponsorship?"): never offered narrative stand-ins. A factual question goes to Paul when code
  // can't place it.
  if (ranked[0]?.canonical.kind === "factual") return rules;
  const candidates = candidatesFrom(ranked);
  if (candidates.length === 0) return rules;
  const outcome = await deps.gateway.call(questionConfirmRoute(), {
    question,
    candidates: candidates.map((c) => c.canonical.text),
  });
  if (outcome.kind !== "Ok") return rules;
  const { choice } = outcome.output;
  const chosen = choice === null ? undefined : candidates[choice];
  if (chosen === undefined) return rules;
  return {
    // The lexical score for the chosen question, so the confidence still means one thing.
    match: {
      status: "matched",
      canonical: chosen.canonical,
      confidence: Math.round(chosen.score * 100) / 100,
      confirmedBy: "model",
    },
    by: "model",
  };
}
