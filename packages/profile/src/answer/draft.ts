import type { CallRecord, LlmGateway } from "@northstar/llm";
import { findAvoided } from "../voice/edits.js";
import { words } from "../voice/words.js";
import { type EvidenceItem, selectEvidence } from "./evidence.js";
import { answerDraftRoute } from "./route.js";
import type { AnswerDraft } from "./schema.js";
import { type AnswerFailure, answerText, validateAnswerDraft } from "./validate.js";

// Drafting an answer to a new narrative question (ANS-004, NS-135). Code decides: it picks the
// evidence, the model drafts from it, and the provenance check decides whether Paul sees the draft
// or a needs-human item. Nothing is stored or sent here; a draft becomes an answer only through
// Paul's approval (ANS-005) and the bank (GH-59).

export type DraftRequest = {
  question: string;
  limit: number | null;
  // How Paul writes (renderVoiceGuide, NS-136). May be empty.
  voiceGuide: string;
  // Phrases Paul keeps deleting from drafts (avoidedPhrases, ANS-008).
  avoid?: readonly string[];
  // Paul's approved stories and his atoms (storyEvidence, atomEvidence).
  items: readonly EvidenceItem[];
};

export type DraftResult =
  // The route is off (ADR-0016 item 8): its fixtures are hand-written until Paul records real
  // ones and sets the baseline.
  | { kind: "off" }
  | { kind: "drafted"; draft: AnswerDraft; evidence: string[]; record: CallRecord }
  | {
      kind: "needs_human";
      reason: "no_evidence" | "refused" | "truncated" | "invalid_output" | "provenance" | "voice";
      failures: AnswerFailure[];
      // For the caller's domain event; null when no call was made.
      record: CallRecord | null;
    };

export async function draftAnswer(
  // `enabled` is false unless the caller turns the route on from config.
  deps: { gateway: LlmGateway; enabled?: boolean },
  request: DraftRequest,
): Promise<DraftResult> {
  if (deps.enabled !== true) return { kind: "off" };
  const evidence = selectEvidence(request.question, request.items);
  // Nothing to stand on: asking the model would only invite invention.
  if (evidence.length === 0) {
    return { kind: "needs_human", reason: "no_evidence", failures: [], record: null };
  }
  // Only the plain words the check below uses reach the prompt: no quotes, line breaks or
  // anything else a caller's text might carry.
  const avoid = (request.avoid ?? []).map((p) => words(p).join(" ")).filter((p) => p !== "");
  // The model is told what to avoid; code still checks below, since telling isn't enough.
  const voiceGuide =
    avoid.length === 0
      ? request.voiceGuide
      : [request.voiceGuide, `Avoid: ${avoid.map((p) => `"${p}"`).join(", ")}.`]
          .filter((line) => line !== "")
          .join("\n");
  // A transport error throws, so the caller's retry policy handles it (llm.md).
  const outcome = await deps.gateway.call(answerDraftRoute(), {
    question: request.question,
    limit: request.limit,
    voiceGuide,
    evidence,
  });
  const needsHuman = (reason: "refused" | "truncated" | "invalid_output") => ({
    kind: "needs_human" as const,
    reason,
    failures: [],
    record: outcome.record,
  });
  switch (outcome.kind) {
    case "Refused":
      return needsHuman("refused");
    case "Truncated":
      return needsHuman("truncated");
    case "InvalidOutput":
      return needsHuman("invalid_output");
    case "Ok": {
      const check = validateAnswerDraft(outcome.output, evidence, request.limit);
      if (!check.ok) {
        return {
          kind: "needs_human",
          reason: "provenance",
          failures: check.failures,
          record: outcome.record,
        };
      }
      // A phrase Paul deleted from three drafts never reaches him again (ANS-008). The failure
      // names the phrase by its position in `avoid`, never the text.
      const avoided = findAvoided(answerText(outcome.output), avoid);
      if (avoided.length > 0) {
        return {
          kind: "needs_human",
          reason: "voice",
          failures: avoided.map((i) => ({
            sentence: null,
            problem: `avoided phrase ${i} is in the draft`,
          })),
          record: outcome.record,
        };
      }
      return {
        kind: "drafted",
        draft: outcome.output,
        evidence: evidence.map((e) => e.id),
        record: outcome.record,
      };
    }
  }
}
