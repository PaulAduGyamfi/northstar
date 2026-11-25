import type { ScoringAtom, ScoringProfile } from "@northstar/db";
import type { CallRecord, LlmGateway, Route } from "@northstar/llm";
import { untrustedBlock } from "@northstar/llm";
import { loadPrompt } from "@northstar/prompts";
import { z } from "zod";
import type { Unmatched } from "./match.js";

// Model-assisted requirement matching (NS-138, MAT-001/002). The rules (match.ts) run first and
// stay the floor: only what they left unmatched goes to the job-match route, and plain code
// decides which of its proposals to believe (ADR-0004: every match cites an atom with a quote
// that is really in it). Off by default until Paul records real fixtures (ADR-0016 item 8).

export const JOB_MATCH_VERSION = 1;

export type JobMatchInput = {
  // The requirements the rules left unmatched, by their index here.
  requirements: string[];
  // Each atom's line and terms as stored; the prompt shows them joined, the check reads them apart.
  atoms: { id: string; what: string; how: string[] }[];
};

export const JobMatchOutput = z
  .object({
    matches: z.array(
      z
        .object({
          requirement: z.number().int().min(0),
          atomId: z.string().nullable(),
          quote: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type JobMatchOutput = z.infer<typeof JobMatchOutput>;

// One accepted model match: the requirement (posting text), the atom and the verbatim quote, and
// which prompt version and model proposed it (`job-match/v1 claude-opus-5-5`), so every
// model-made claim says where it came from (OBV-003).
export type ModelMatch = { requirement: string; atomId: string; quote: string; stamp?: string };

// An atom as the model sees it: its line, then its terms in parentheses.
export const atomText = (a: Pick<ScoringAtom, "what" | "how">): string =>
  a.how.length > 0 ? `${a.what} (${a.how.join(", ")})` : a.what;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
// Words too small to show anything by themselves.
const SMALL_WORDS = new Set(
  "a an and as at by for from in into of on or the to with we our i my".split(" "),
);
const WORD = /[\p{L}\p{N}+#.]+/gu;

// Whether `quote` is real evidence from this atom (plain code, ADR-0004): at least two whole
// words, not all of them small words, found verbatim (whitespace aside) on word boundaries in
// the atom's line or in one of its terms. A quote can't run across the line and its terms, and
// a fragment such as "the" or "ead a tea" never counts.
export function quoteInAtom(atom: Pick<ScoringAtom, "what" | "how">, quote: string): boolean {
  const q = squash(quote);
  const words = q.match(WORD) ?? [];
  if (words.length < 2 || words.every((w) => SMALL_WORDS.has(w.toLowerCase()))) return false;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u");
  return [atom.what, ...atom.how].some((part) => pattern.test(squash(part)));
}

export function jobMatchInput(unmatched: Unmatched[], profile: ScoringProfile): JobMatchInput {
  return {
    requirements: unmatched.map((u) => u.requirement),
    atoms: profile.atoms.map((a) => ({ id: a.id, what: a.what, how: [...a.how] })),
  };
}

export function renderRequirements(input: JobMatchInput): string {
  return input.requirements.map((r, i) => `[${i}] ${r}`).join("\n");
}

export function renderAtoms(input: JobMatchInput): string {
  return input.atoms.map((a) => `[${a.id}] ${atomText(a)}`).join("\n");
}

// The job-match route: unmatched requirements (an employer's text) and Paul's atoms (resume
// text) in, a proposed atom and verbatim quote per requirement out. Both blocks are untrusted
// (NFR-SEC-004) and the route has no tools.
export function jobMatchRoute(): Route<JobMatchInput, JobMatchOutput> {
  const prompt = loadPrompt("job-match", JOB_MATCH_VERSION);
  return {
    name: "job-match",
    prompt,
    // Judging whether a line of evidence meets a requirement: medium, with the eval as the check.
    effort: "medium",
    maxTokens: 4_000,
    timeoutMs: 90_000,
    output: JobMatchOutput,
    render: (input) => ({
      stable: [],
      volatile: [
        untrustedBlock("requirements", renderRequirements(input)),
        untrustedBlock("atoms", renderAtoms(input)),
      ].join("\n\n"),
    }),
  };
}

// Plain code, no model: the proposals that hold. A proposal counts only when its requirement
// index is one the input sent, its atom is one the input sent, and its quote passes quoteInAtom.
// A requirement proposed twice keeps its first match.
export function checkJobMatches(output: JobMatchOutput, input: JobMatchInput): ModelMatch[] {
  const atoms = new Map(input.atoms.map((a) => [a.id, a]));
  const taken = new Set<number>();
  const accepted: ModelMatch[] = [];
  for (const m of output.matches) {
    const requirement = input.requirements[m.requirement];
    if (requirement === undefined || taken.has(m.requirement)) continue;
    if (m.atomId === null || m.quote === null) continue;
    const atom = atoms.get(m.atomId);
    const quote = squash(m.quote);
    if (atom === undefined || !quoteInAtom(atom, quote)) continue;
    taken.add(m.requirement);
    accepted.push({ requirement, atomId: m.atomId, quote });
  }
  return accepted;
}

export type AssistResult =
  | { kind: "assisted"; matches: ModelMatch[]; record: CallRecord }
  // off: not turned on; nothing: no unmatched requirement or no atom, so no call.
  | { kind: "skipped"; reason: "off" | "nothing" }
  | { kind: "failed"; reason: "refused" | "truncated" | "invalid_output"; record: CallRecord };

// Asks the job-match route about what the rules left unmatched, and keeps what checks out.
// `enabled` is false unless the caller turns the route on.
export async function assistUnmatched(
  deps: { gateway: LlmGateway; enabled?: boolean },
  unmatched: Unmatched[],
  profile: ScoringProfile,
): Promise<AssistResult> {
  if (deps.enabled !== true) return { kind: "skipped", reason: "off" };
  if (unmatched.length === 0 || profile.atoms.length === 0) {
    return { kind: "skipped", reason: "nothing" };
  }
  const input = jobMatchInput(unmatched, profile);
  // A transport error throws, so the caller decides (scorePending keeps the rules score).
  const outcome = await deps.gateway.call(jobMatchRoute(), input);
  switch (outcome.kind) {
    case "Refused":
      return { kind: "failed", reason: "refused", record: outcome.record };
    case "Truncated":
      return { kind: "failed", reason: "truncated", record: outcome.record };
    case "InvalidOutput":
      return { kind: "failed", reason: "invalid_output", record: outcome.record };
    case "Ok":
      return {
        kind: "assisted",
        matches: checkJobMatches(outcome.output, input).map((m) => ({
          ...m,
          stamp: `${outcome.record.promptId}/v${outcome.record.promptVersion} ${outcome.record.modelServed}`,
        })),
        record: outcome.record,
      };
  }
}
