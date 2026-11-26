import type { CallRecord, LlmGateway } from "@northstar/llm";
import { checkRecruiterFacts } from "./check.js";
import { RECRUITER_EMAIL_LIMIT, recruiterExtractRoute } from "./route.js";
import type { RecruiterFacts } from "./schema.js";

// Reading one recruiter email (REC-001, NS-167): the model reads, the check keeps only what the
// email states, and the grader (packages/sources) decides. Nothing is stored or sent here.

export type RecruiterExtractResult =
  // Off until Paul records real fixtures and sets the baseline (ADR-0016 item 8).
  | { kind: "off" }
  | { kind: "extracted"; facts: RecruiterFacts; dropped: string[]; record: CallRecord }
  | {
      kind: "needs_human";
      reason: "refused" | "truncated" | "invalid_output";
      record: CallRecord;
    };

export async function extractRecruiterFacts(
  // `enabled` is false unless the caller turns the route on from config.
  deps: { gateway: LlmGateway; enabled?: boolean },
  rawEmail: string,
): Promise<RecruiterExtractResult> {
  if (deps.enabled !== true) return { kind: "off" };
  // The same cut text the route sees is what the check reads.
  const email = rawEmail.slice(0, RECRUITER_EMAIL_LIMIT);
  // A transport error or a held-back call throws, for the caller's retry policy (llm.md).
  const outcome = await deps.gateway.call(recruiterExtractRoute(), { email });
  switch (outcome.kind) {
    case "Refused":
      return { kind: "needs_human", reason: "refused", record: outcome.record };
    case "Truncated":
      return { kind: "needs_human", reason: "truncated", record: outcome.record };
    case "InvalidOutput":
      return { kind: "needs_human", reason: "invalid_output", record: outcome.record };
    case "Ok": {
      const { facts, dropped } = checkRecruiterFacts(outcome.output, email);
      return { kind: "extracted", facts, dropped, record: outcome.record };
    }
  }
}
