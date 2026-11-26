import type { Route } from "@northstar/llm";
import { untrustedBlock } from "@northstar/llm";
import { loadPrompt } from "@northstar/prompts";
import type { EvidenceItem } from "../answer/evidence.js";
import { renderEvidence } from "../answer/route.js";
import { ReplyDraft } from "./schema.js";

// v1 and v2 were replaced before they shipped (NS-166's security review): v1 bounded framing by
// a blocklist and v2 by a word list, and both let a sender's email make framing say yes. v3 lists
// the exact framing sentences validate.ts allows.
export const REPLY_DRAFT_VERSION = 3;

// The most characters of the email the route sees.
export const EMAIL_LIMIT = 8_000;

export type ReplyDraftInput = {
  // The email's text, already cut to EMAIL_LIMIT.
  email: string;
  // The sender's first name for the greeting (greetingName), or null for no name.
  sender: string | null;
  // From replyNeed (plain code): "reply" or "reply_without_times". No reply proposes times until
  // Calendar exists (RPL-003, NS-169); the second also asks it to say availability will follow.
  need: "reply" | "reply_without_times";
  // How Paul writes (ANS-007). May be empty.
  voiceGuide: string;
  evidence: EvidenceItem[];
};

// The reply-draft route (RPL-001, NS-166): a job email and Paul's stories and atoms in, a reply
// whose every claim cites them out. Every block is untrusted: the email comes from outside, and
// stories hold text Paul typed or pasted. No tools.
export function replyDraftRoute(): Route<ReplyDraftInput, ReplyDraft> {
  const prompt = loadPrompt("reply-draft", REPLY_DRAFT_VERSION);
  return {
    name: "reply-draft",
    prompt,
    // Keep-his-words drafting from given material, like answer-draft (ADR-0006).
    effort: "medium",
    // A reply can wait a few hours, unlike a fresh job, but it is more than background work
    // (ADR-0021).
    priority: "normal",
    maxTokens: 8_000,
    timeoutMs: 120_000,
    output: ReplyDraft,
    render: ({ email, sender, need, voiceGuide, evidence }) => ({
      stable: [],
      volatile: [
        untrustedBlock("email", email),
        untrustedBlock("sender", sender ?? "none"),
        untrustedBlock("need", need),
        untrustedBlock("voice", voiceGuide),
        untrustedBlock("evidence", renderEvidence(evidence)),
      ].join("\n\n"),
    }),
  };
}
