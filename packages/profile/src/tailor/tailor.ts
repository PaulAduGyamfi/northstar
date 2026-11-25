import { normalize } from "../validate.js";
import { atomTerms, mentions } from "./terms.js";
import type { Line, MasterAtom, MasterResume, TailoredResume, TailorJob } from "./types.js";

// The deterministic tailor (NS-117, TLR-001): selects and orders the master's atoms for one job
// and never rewords them. Plain code, no model: the same master and job give the same resume.

export type TailorOptions = {
  // Bullet lines to keep. The default is a guess at one page; tailorToPages (NS-145) measures the
  // rendered PDF instead (TLR-001).
  maxLines?: number;
};

export const DEFAULT_MAX_LINES = 16;

// Bullet markers a resume line may start with; the rendered resume adds its own.
const BULLET = /^[\s•·▪◦‣*-]+/;

// The atom's resume line as one tidy line: typography normalised, its bullet marker removed.
export function lineText(atom: MasterAtom): string {
  return normalize(atom.sourceQuote).replace(BULLET, "");
}

type Requirement = { text: string; weight: number };

// Must-haves count twice what nice-to-haves do, as in fit scoring's weights.
function requirementsOf(job: TailorJob): Requirement[] {
  return [
    ...job.requirements.map((text) => ({ text, weight: 2 })),
    ...job.niceToHaves.map((text) => ({ text, weight: 1 })),
  ];
}

export function tailorResume(
  master: MasterResume,
  job: TailorJob,
  options: TailorOptions = {},
): TailoredResume {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const reqs = requirementsOf(job);
  const terms = new Map(master.atoms.map((a) => [a.id, atomTerms(a, master.skills)]));
  const relevance = new Map(
    master.atoms.map((a) => {
      const own = terms.get(a.id) ?? [];
      const score = reqs
        .filter((r) => own.some((t) => mentions(r.text, t)))
        .reduce((s, r) => s + r.weight, 0);
      return [a.id, score];
    }),
  );
  const position = new Map(master.atoms.map((a, i) => [a.id, i]));
  const rel = (a: MasterAtom) => relevance.get(a.id) ?? 0;
  const pos = (a: MasterAtom) => position.get(a.id) ?? 0;

  // Over budget: drop the least relevant first, and on a tie the one further down the resume.
  const dropOrder = [...master.atoms].sort((a, b) => rel(a) - rel(b) || pos(b) - pos(a));
  const dropped = new Set(
    dropOrder.slice(0, Math.max(0, master.atoms.length - maxLines)).map((a) => a.id),
  );

  // Most relevant first inside a section, resume order on a tie.
  const linesFor = (roleId: string | null): Line[] =>
    master.atoms
      .filter((a) => a.roleId === roleId && !dropped.has(a.id))
      .sort((a, b) => rel(b) - rel(a) || pos(a) - pos(b))
      .map((a) => ({ text: lineText(a), atomIds: [a.id] }));

  // Every role keeps its section, even with no lines left: dropping one would hide a period of
  // the work history. Projects only when the master has any.
  const sections: TailoredResume["sections"] = master.roles.map((r) => ({
    roleId: r.id,
    lines: linesFor(r.id),
  }));
  if (master.atoms.some((a) => a.roleId === null)) {
    sections.push({ roleId: null, lines: linesFor(null) });
  }

  return {
    summary: [],
    sections,
    skills: tailorSkills(master, reqs),
    notClaimed: reqs
      .filter(
        (r) =>
          !master.skills.some((s) => mentions(r.text, s)) &&
          ![...terms.values()].some((ts) => ts.some((t) => mentions(r.text, t))),
      )
      .map((r) => `not claimed: ${r.text} (no evidence)`),
  };
}

// Skills the job names first, in the job's order: the master's own, plus any term an atom's
// `how` proves that the skills section lacks (added, citing those atoms). Then the rest of the
// master's skills in resume order.
function tailorSkills(master: MasterResume, reqs: Requirement[]): TailoredResume["skills"] {
  const known = new Set(master.skills.map((s) => s.toLowerCase()));
  const proven = new Map<string, { name: string; atomIds: string[] }>();
  for (const a of master.atoms) {
    for (const h of a.how) {
      const key = h.toLowerCase();
      if (known.has(key)) continue;
      const entry = proven.get(key) ?? { name: h, atomIds: [] };
      entry.atomIds.push(a.id);
      proven.set(key, entry);
    }
  }
  const out: TailoredResume["skills"] = [];
  const taken = new Set<string>();
  const take = (name: string, atomIds: string[], added: boolean) => {
    if (taken.has(name.toLowerCase())) return;
    taken.add(name.toLowerCase());
    out.push({ name, atomIds, added });
  };
  for (const r of reqs) {
    for (const s of master.skills) if (mentions(r.text, s)) take(s, [], false);
    for (const p of proven.values()) if (mentions(r.text, p.name)) take(p.name, p.atomIds, true);
  }
  for (const s of master.skills) take(s, [], false);
  return out;
}
