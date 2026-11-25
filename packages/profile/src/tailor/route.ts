import type { Route } from "@northstar/llm";
import { untrustedBlock } from "@northstar/llm";
import { loadPrompt } from "@northstar/prompts";
import { TailoredResume, type TailorJob } from "./types.js";

export const RESUME_TAILOR_VERSION = 1;

export type ResumeTailorInput = {
  // The deterministic tailor's resume (tailorResume): the model rewords it, never restructures it.
  base: TailoredResume;
  atoms: { id: string; roleId: string | null; line: string }[];
  // Context only: employers, titles and dates are rendered from the master, never from the model.
  roles: { id: string; title: string; employer: string }[];
  skills: string[];
  job: TailorJob;
};

// The job as plain lines. It comes from an employer's page, so it is untrusted text.
export function renderJob(job: TailorJob): string {
  const list = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
  return [
    `Title: ${job.title ?? "(none)"}`,
    "Requirements:",
    list(job.requirements),
    "Nice to have:",
    list(job.niceToHaves),
  ].join("\n");
}

// Paul's side: his roles, atoms and skills, and the base resume. His own text, but it may hold
// pasted material, so it is untrusted too.
export function renderProfile(input: Omit<ResumeTailorInput, "job">): string {
  return [
    "Roles:",
    ...input.roles.map((r) => `[${r.id}] ${r.title}, ${r.employer}`),
    "Atoms:",
    ...input.atoms.map((a) => `[${a.id}] (${a.roleId ?? "projects"}) ${a.line}`),
    `Skills: ${input.skills.join(", ")}`,
    "Base resume (JSON):",
    JSON.stringify(input.base),
  ].join("\n");
}

// The resume-tailor route (TLR-001, NS-144): rewords the deterministic tailor's lines toward the
// job's terms and writes a summary, every line citing atoms. Its output must pass
// validateTailoredResume and tailorWithModel's own rules before anyone sees it. No tools.
export function resumeTailorRoute(): Route<ResumeTailorInput, TailoredResume> {
  const prompt = loadPrompt("resume-tailor", RESUME_TAILOR_VERSION);
  return {
    name: "resume-tailor",
    prompt,
    // Careful rewording of given lines, not open judgment: medium, with the eval as the check.
    effort: "medium",
    // A one-page resume as JSON.
    maxTokens: 8_000,
    timeoutMs: 120_000,
    output: TailoredResume,
    render: ({ job, ...profile }) => ({
      stable: [],
      volatile: [
        untrustedBlock("job", renderJob(job)),
        untrustedBlock("profile", renderProfile(profile)),
      ].join("\n\n"),
    }),
  };
}
