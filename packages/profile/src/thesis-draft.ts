import type { ThesisProfile } from "@northstar/db";
import type { CallRecord, LlmGateway, Route } from "@northstar/llm";
import { untrustedBlock } from "@northstar/llm";
import { loadPrompt } from "@northstar/prompts";
import { z } from "zod";
import {
  checkThesis,
  THESIS_MAX_LENGTH,
  type ThesisEvidence,
  type ThesisFailure,
} from "./thesis.js";

// The guided positioning-thesis session (NS-152, DX-009). The model drafts up to three
// one-sentence theses from Paul's profile, each citing atoms; plain code (checkThesis) decides
// which ones Paul ever sees. Nothing is saved here: Paul chooses one and saves it with
// `profile thesis set`. Off by default until Paul records real fixtures (ADR-0016 item 8).

export const POSITIONING_THESIS_VERSION = 1;
export const MAX_CANDIDATES = 3;

// checkThesis's evidence for a thesis citing `atomIds`: those atoms' verbatim resume lines, all
// roles (for "N years") and all skills. Unknown ids come back separately, never dropped quietly.
export function thesisEvidence(
  profile: ThesisProfile,
  atomIds: readonly string[],
  asOf: string,
): { evidence: ThesisEvidence; unknown: string[]; cited: number } {
  const byId = new Map(profile.atoms.map((a) => [a.id, a.quote]));
  const ids = [...new Set(atomIds)];
  const unknown = ids.filter((id) => !byId.has(id));
  const quotes = ids.flatMap((id) => {
    const quote = byId.get(id);
    return quote === undefined ? [] : [quote];
  });
  return {
    evidence: { quotes, roles: profile.roles, skills: profile.skills, asOf },
    unknown,
    cited: quotes.length,
  };
}

export const ThesisCandidates = z
  .object({
    candidates: z
      .array(
        z
          .object({
            text: z.string().min(1).max(THESIS_MAX_LENGTH),
            atomIds: z.array(z.string()).min(1),
          })
          .strict(),
      )
      .max(MAX_CANDIDATES),
  })
  .strict();
export type ThesisCandidates = z.infer<typeof ThesisCandidates>;

export function renderThesisProfile(profile: ThesisProfile): string {
  const role = (r: ThesisProfile["roles"][number]) =>
    `${r.title}, ${r.employer} (${r.startMonth ?? "?"} to ${r.current ? "now" : (r.endMonth ?? "?")})`;
  return [
    "Roles:",
    ...profile.roles.map((r) => `- ${role(r)}`),
    "Atoms:",
    ...profile.atoms.map((a) => `[${a.id}] ${a.quote}`),
    `Skills: ${profile.skills.join(", ")}`,
  ].join("\n");
}

// The positioning-thesis route: Paul's profile in (his resume text, which may hold pasted
// material, so it is untrusted), up to three candidates out. No tools.
export function positioningThesisRoute(): Route<ThesisProfile, ThesisCandidates> {
  const prompt = loadPrompt("positioning-thesis", POSITIONING_THESIS_VERSION);
  return {
    name: "positioning-thesis",
    prompt,
    // A short piece of careful writing from given evidence: medium, with the eval as the check.
    effort: "medium",
    maxTokens: 1_500,
    timeoutMs: 60_000,
    output: ThesisCandidates,
    render: (profile) => ({
      stable: [],
      volatile: untrustedBlock("profile", renderThesisProfile(profile)),
    }),
  };
}

export type DraftedThesis = { text: string; atomIds: string[] };

export type ThesisDraftResult =
  | { kind: "drafted"; theses: DraftedThesis[]; dropped: number; record: CallRecord }
  // off: not turned on; no_atoms: nothing to cite, so no call.
  | { kind: "skipped"; reason: "off" | "no_atoms" }
  | { kind: "failed"; reason: "refused" | "truncated" | "invalid_output"; record: CallRecord };

// Why a candidate was dropped: checkThesis's failures, or atom ids not in the profile. This
// proves "backed by the cited resume text", not "true": a line planted in the resume itself
// passes when cited, so Paul reads every draft before `thesis set` (the eval's `forbidden`
// words cover that case).
export function thesisProblems(
  candidate: DraftedThesis,
  profile: ThesisProfile,
  asOf: string,
): (ThesisFailure | { kind: "unknown_atom"; id: string })[] {
  const { evidence, unknown, cited } = thesisEvidence(profile, candidate.atomIds, asOf);
  return [
    ...unknown.map((id) => ({ kind: "unknown_atom" as const, id })),
    ...checkThesis(candidate.text, evidence, cited),
  ];
}

// Drafts theses and keeps only those that pass. `enabled` is false unless the caller turns the
// route on. A transport error throws, so the CLI reports it.
export async function draftTheses(
  deps: { gateway: LlmGateway; enabled?: boolean },
  profile: ThesisProfile,
  asOf: string,
): Promise<ThesisDraftResult> {
  if (deps.enabled !== true) return { kind: "skipped", reason: "off" };
  if (profile.atoms.length === 0) return { kind: "skipped", reason: "no_atoms" };
  const outcome = await deps.gateway.call(positioningThesisRoute(), profile);
  switch (outcome.kind) {
    case "Refused":
      return { kind: "failed", reason: "refused", record: outcome.record };
    case "Truncated":
      return { kind: "failed", reason: "truncated", record: outcome.record };
    case "InvalidOutput":
      return { kind: "failed", reason: "invalid_output", record: outcome.record };
    case "Ok": {
      const passing = outcome.output.candidates
        .map((c) => ({ text: c.text.trim(), atomIds: [...new Set(c.atomIds)] }))
        .filter((c) => thesisProblems(c, profile, asOf).length === 0);
      return {
        kind: "drafted",
        theses: passing,
        dropped: outcome.output.candidates.length - passing.length,
        record: outcome.record,
      };
    }
  }
}
