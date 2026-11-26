import type { Route } from "@northstar/llm";
import { untrustedBlock } from "@northstar/llm";
import { loadPrompt } from "@northstar/prompts";
import { RecruiterFacts } from "./schema.js";

export const RECRUITER_EXTRACT_VERSION = 1;

// The most characters of the email the route sees: a recruiter's pitch is up front, and quoted
// history adds cost, not facts.
export const RECRUITER_EMAIL_LIMIT = 8_000;

export type RecruiterExtractInput = { email: string };

// The recruiter-extract route (REC-001, NS-167): one recruiter email in, the facts it states out.
// The email is untrusted (NFR-SEC-004), the route has no tools, and it never grades: code does.
export function recruiterExtractRoute(): Route<RecruiterExtractInput, RecruiterFacts> {
  const prompt = loadPrompt("recruiter-extract", RECRUITER_EXTRACT_VERSION);
  return {
    name: "recruiter-extract",
    prompt,
    // Copy-exact extraction from one short email, like mail-classify (ADR-0006).
    effort: "low",
    maxTokens: 2_000,
    timeoutMs: 60_000,
    // A recruiter can wait a few hours, but this is Paul's own inbox, not backfill (ADR-0021).
    priority: "normal",
    output: RecruiterFacts,
    render: ({ email }) => ({ stable: [], volatile: untrustedBlock("email", email) }),
  };
}
