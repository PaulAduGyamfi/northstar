import { replyNeed } from "@northstar/domain";
import type { CallRecord, LlmGateway } from "@northstar/llm";
import { type EvidenceItem, selectEvidence } from "../answer/evidence.js";
import { findAvoided } from "../voice/edits.js";
import { words } from "../voice/words.js";
import { EMAIL_LIMIT, replyDraftRoute } from "./route.js";
import type { ReplyDraft } from "./schema.js";
import { greetingName, type ReplyFailure, replyText, validateReplyDraft } from "./validate.js";

// Drafting a reply to a job email (RPL-001, NS-166). Code decides: replyNeed says whether the
// email gets a reply at all, code picks the evidence, the model drafts, and the check decides
// whether Paul sees the draft or a needs-human item. Nothing is stored, filed or sent here, and
// nothing is written to Gmail: a later slice files the draft with the Gate (RPL-002).

export type ReplyRequest = {
  // The email's classification (mail-classify, NS-164).
  kind: string;
  // The email's text. Untrusted.
  email: string;
  // The From header's display name, parsed by code. Only its first word, and only when it is a
  // plain name (greetingName), may appear in the greeting.
  senderName: string | null;
  // How Paul writes (renderVoiceGuide). May be empty.
  voiceGuide: string;
  // Phrases Paul keeps deleting from drafts (ANS-008).
  avoid?: readonly string[];
  // Paul's approved stories and his atoms (storyEvidence, atomEvidence).
  items: readonly EvidenceItem[];
};

export type ReplyResult =
  // The route is off (ADR-0016 item 8): hand-written fixtures until Paul records real ones.
  | { kind: "off" }
  // replyNeed says this email gets no reply.
  | { kind: "none" }
  | { kind: "drafted"; draft: ReplyDraft; evidence: string[]; record: CallRecord }
  | {
      kind: "needs_human";
      reason: "refused" | "truncated" | "invalid_output" | "provenance" | "voice";
      failures: ReplyFailure[];
      record: CallRecord;
    };

export async function draftReply(
  // `enabled` is false unless the caller turns the route on from config.
  deps: { gateway: LlmGateway; enabled?: boolean },
  request: ReplyRequest,
): Promise<ReplyResult> {
  if (deps.enabled !== true) return { kind: "off" };
  const need = replyNeed(request.kind);
  if (need === "none") return { kind: "none" };
  // A long thread's quoted history adds cost, not context.
  const email = request.email.slice(0, EMAIL_LIMIT);
  // May be empty: a reply that only accepts an invite needs no evidence, and its framing is
  // still checked.
  const evidence = selectEvidence(email, request.items);
  // Only plain words reach the prompt (as in draftAnswer).
  const avoid = (request.avoid ?? []).map((p) => words(p).join(" ")).filter((p) => p !== "");
  const voiceGuide =
    avoid.length === 0
      ? request.voiceGuide
      : [request.voiceGuide, `Avoid: ${avoid.map((p) => `"${p}"`).join(", ")}.`]
          .filter((line) => line !== "")
          .join("\n");
  // A transport error or a held-back call throws, for the caller's retry policy (llm.md).
  const outcome = await deps.gateway.call(replyDraftRoute(), {
    email,
    sender: greetingName(request.senderName),
    need,
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
      const check = validateReplyDraft(outcome.output, evidence, request.senderName);
      if (!check.ok) {
        return {
          kind: "needs_human",
          reason: "provenance",
          failures: check.failures,
          record: outcome.record,
        };
      }
      // A phrase Paul deleted from three drafts never reaches him again (ANS-008), named by its
      // position in `avoid`, never its text.
      const avoided = findAvoided(replyText(outcome.output), avoid);
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
