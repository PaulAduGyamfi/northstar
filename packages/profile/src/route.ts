import type { Route } from "@northstar/llm";
import { untrustedBlock } from "@northstar/llm";
import { loadPrompt } from "@northstar/prompts";
import { ProfileExtract } from "./schema.js";

export const PROFILE_EXTRACT_VERSION = 1;

// The profile-extract route (NS-110): resume text in, structured profile records out. The resume
// is the volatile part, inside an untrusted block, so a line in it can't act as an instruction.
export function profileExtractRoute(): Route<{ text: string }, ProfileExtract> {
  const prompt = loadPrompt("profile-extract", PROFILE_EXTRACT_VERSION);
  return {
    name: "profile-extract",
    prompt,
    // Extraction, not judgment: medium is enough; the eval set is the check (ADR-0006).
    effort: "medium",
    // A long resume with many bullets; truncation is reported, never partly stored.
    maxTokens: 16_000,
    timeoutMs: 180_000,
    output: ProfileExtract,
    render: ({ text }) => ({ stable: [], volatile: untrustedBlock("resume", text) }),
  };
}
