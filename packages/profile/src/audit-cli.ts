import type { AuditRun, DecisionRefusal, DecisionRun } from "./audit/run.js";

// `profile audit`, `profile audit accept <key> "<new line>"` and `profile audit reject <key>`
// (NS-190, AUD-001/002). Paul only: it prints his real resume lines back to him.

export type AuditCliDeps = {
  print: (line: string) => void;
  runAudit: () => Promise<AuditRun>;
  acceptSuggestion: (key: string, newLine: string) => Promise<DecisionRun>;
  rejectSuggestion: (key: string) => Promise<DecisionRun>;
};

export const AUDIT_USAGE =
  'usage: profile audit | profile audit accept <key> "<new line>" | profile audit reject <key>';

const REFUSED: Record<DecisionRefusal, string> = {
  NoProfile: "No resume imported yet. Run: profile import-resume data/<file>",
  NoAudit: "No audit yet. Run: profile audit",
  UnknownSuggestion: "The newest audit has no suggestion with that key. Run: profile audit",
  AlreadyDecided: "You already decided that suggestion.",
  StaleAudit: "That audit read an older resume import. Run: profile audit",
  NotALine: "Only a suggestion about one line can take a new line; reject this one instead.",
  not_a_line: "Only a suggestion about one line can take a new line; reject this one instead.",
  EmptyLine: "The new line is empty.",
  empty: "The new line is empty.",
  unknown_atom: "That line is no longer in your resume. Run: profile audit",
  multi_line: "Write the new line as one line.",
  MultiLine: "Write the new line as one line.",
  names_other_role:
    "The new line names another role's employer, title or years: keep it to this role.",
};

export async function auditCommand(deps: AuditCliDeps, args: string[]): Promise<number> {
  if (args.length === 0) return show(deps, await deps.runAudit());
  const [action, key, line, ...rest] = args;
  if (action === "accept" && key && line !== undefined && rest.length === 0) {
    return decided(deps, await deps.acceptSuggestion(key, line));
  }
  if (action === "reject" && key && line === undefined) {
    return decided(deps, await deps.rejectSuggestion(key));
  }
  deps.print(AUDIT_USAGE);
  return 1;
}

function show(deps: AuditCliDeps, run: AuditRun): number {
  if (run.kind === "refused") {
    deps.print(REFUSED[run.reason]);
    return 1;
  }
  const { audit, master } = run;
  const s = audit.scores;
  deps.print(
    `Overall ${audit.overall}/100: impact ${s.impact}, verbs ${s.verbs}, ATS ${s.ats}, length ${s.length}, keywords ${s.keywords}, consistency ${s.consistency} (${audit.pages} page${audit.pages === 1 ? "" : "s"})`,
  );
  const lines = new Map(master.atoms.map((a) => [a.id, a.sourceQuote]));
  for (const x of audit.suggestions) {
    deps.print(`${x.id}`);
    if ("atomId" in x.target) deps.print(`  line: ${lines.get(x.target.atomId) ?? "?"}`);
    deps.print(`  ${x.message}`);
  }
  if (audit.suggestions.length === 0) deps.print("No suggestions.");
  if (run.hidden > 0) {
    deps.print(
      `${run.hidden} suggestion${run.hidden === 1 ? "" : "s"} you rejected before on this resume ${run.hidden === 1 ? "is" : "are"} left out.`,
    );
  }
  deps.print(
    'Saved. Accept one with your own line: profile audit accept <key> "<new line>". Reject: profile audit reject <key>.',
  );
  return 0;
}

function decided(deps: AuditCliDeps, run: DecisionRun): number {
  if (run.kind === "refused") {
    deps.print(`Not saved: ${REFUSED[run.reason]}`);
    return 1;
  }
  deps.print(
    run.decision === "accepted"
      ? `Accepted ${run.key}. Tailored resumes use your new line from now on.`
      : `Rejected ${run.key}. It won't come back for this resume import.`,
  );
  return 0;
}
