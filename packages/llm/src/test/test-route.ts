import { z } from "zod";
import type { Route } from "../route.js";
import { untrustedBlock } from "../untrusted.js";

// A route that exists only for tests: classify a synthetic job snippet as remote or onsite.
export const TestOutput = z.object({
  label: z.enum(["remote", "onsite"]),
  confidence: z.number().min(0).max(1),
});

export const testRoute: Route<{ jobText: string }, z.infer<typeof TestOutput>> = {
  name: "test-classify",
  prompt: { id: "test-classify", version: 1, text: "You label job snippets as remote or onsite." },
  effort: "low",
  maxTokens: 1024,
  timeoutMs: 30_000,
  output: TestOutput,
  render: (input) => ({
    stable: ["Candidate prefers remote roles."],
    volatile: untrustedBlock("job_page", input.jobText),
  }),
};
