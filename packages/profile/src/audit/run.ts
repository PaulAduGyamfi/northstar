import type {
  AuditDecideError,
  AuditDecideInput,
  AuditInput,
  AuditView,
  SaveAuditInput,
} from "@northstar/db";
import type { MasterResume } from "../tailor/types.js";
import { type ApplyRefusal, applySuggestion } from "./apply.js";
import { auditResume, type ResumeAudit, type Suggestion } from "./audit.js";

// Running and deciding the resume audit end to end (NS-190, AUD-001/002): plain code, no model.
// The audit reads the current import with Paul's accepted lines in place, leaves out what he
// rejected on this import, and is stored; a decision is checked here (applySuggestion) and then
// stored through packages/db, which writes an accepted line as the atom's newest edit.

type DecideArgs = AuditDecideInput extends infer D
  ? D extends unknown
    ? Omit<D, "candidateId">
    : never
  : never;

export type AuditRunDeps = {
  readInput: () => Promise<AuditInput | null>;
  rejected: (profileSourceId: string) => Promise<Set<string>>;
  save: (input: Omit<SaveAuditInput, "candidateId">) => Promise<{ auditId: string }>;
  readLatest: () => Promise<AuditView | null>;
  decide: (
    input: DecideArgs,
  ) => Promise<
    { ok: true; value: { decisionId: string } } | { ok: false; error: AuditDecideError }
  >;
};

export type AuditRun =
  | { kind: "refused"; reason: "NoProfile" }
  | {
      kind: "audited";
      auditId: string;
      audit: ResumeAudit;
      master: MasterResume;
      // Suggestions left out because Paul rejected them before on this import.
      hidden: number;
    };

export async function runAudit(deps: AuditRunDeps): Promise<AuditRun> {
  const input = await deps.readInput();
  if (!input) return { kind: "refused", reason: "NoProfile" };
  const master: MasterResume = input.master;
  const full = await auditResume(master, input.targets);
  const rejected = await deps.rejected(input.profileSourceId);
  const suggestions = full.suggestions.filter((s) => !rejected.has(s.id));
  const audit: ResumeAudit = { ...full, suggestions };
  const { auditId } = await deps.save({
    profileSourceId: input.profileSourceId,
    targets: input.targets,
    scores: audit.scores,
    overall: audit.overall,
    pages: audit.pages,
    suggestions: suggestions.map((s) => ({ ...s, target: { ...s.target } })),
  });
  return {
    kind: "audited",
    auditId,
    audit,
    master,
    hidden: full.suggestions.length - suggestions.length,
  };
}

export type DecisionRefusal =
  | "NoAudit"
  | "NoProfile"
  | AuditDecideError["kind"]
  // From applySuggestion: the line can't replace that atom's line.
  | ApplyRefusal;

export type DecisionRun =
  | { kind: "refused"; reason: DecisionRefusal }
  | { kind: "decided"; decision: "accepted" | "rejected"; key: string };

// Accepts one suggestion of the newest run with Paul's own line, checked by applySuggestion
// against the current master first (no other role's employer, title or year; one line).
export async function acceptSuggestion(
  deps: AuditRunDeps,
  key: string,
  newLine: string,
): Promise<DecisionRun> {
  const latest = await deps.readLatest();
  if (!latest) return { kind: "refused", reason: "NoAudit" };
  const stored = latest.suggestions.find((s) => s.id === key);
  if (!stored) return { kind: "refused", reason: "UnknownSuggestion" };
  const input = await deps.readInput();
  if (!input) return { kind: "refused", reason: "NoProfile" };
  if (input.profileSourceId !== latest.profileSourceId) {
    return { kind: "refused", reason: "StaleAudit" };
  }
  // Only a suggestion about one atom's line takes a new line; the stored target is jsonb.
  const atomId = typeof stored.target.atomId === "string" ? stored.target.atomId : null;
  if (atomId === null) return { kind: "refused", reason: "not_a_line" };
  const suggestion: Suggestion = {
    id: stored.id,
    kind: stored.kind as Suggestion["kind"],
    dimension: stored.dimension as Suggestion["dimension"],
    target: { atomId },
    message: stored.message,
  };
  const applied = applySuggestion(input.master, suggestion, newLine);
  if (!applied.ok) return { kind: "refused", reason: applied.reason };
  // The normalised line applySuggestion produced, so what is stored is what was checked.
  const line = applied.master.atoms.find((a) => a.id === atomId)?.sourceQuote;
  if (line === undefined) return { kind: "refused", reason: "unknown_atom" };
  const r = await deps.decide({
    auditId: latest.auditId,
    key,
    decision: "accepted",
    newLine: line,
  });
  if (!r.ok) return { kind: "refused", reason: r.error.kind };
  return { kind: "decided", decision: "accepted", key };
}

// Rejects one suggestion of the newest run; it won't come back on this import.
export async function rejectSuggestion(deps: AuditRunDeps, key: string): Promise<DecisionRun> {
  const latest = await deps.readLatest();
  if (!latest) return { kind: "refused", reason: "NoAudit" };
  const r = await deps.decide({ auditId: latest.auditId, key, decision: "rejected" });
  if (!r.ok) return { kind: "refused", reason: r.error.kind };
  return { kind: "decided", decision: "rejected", key };
}
