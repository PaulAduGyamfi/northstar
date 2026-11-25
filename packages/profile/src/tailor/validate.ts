import { normalize, numbers } from "../validate.js";
import { atomNames, mentions } from "./terms.js";
import type { Line, MasterAtom, MasterResume, TailoredResume } from "./types.js";

// The deterministic provenance check for tailored resumes (NS-117, TLR-002, ADR-0004): plain code,
// no model. Every line must rest on atoms of the master, and may only state the numbers and name
// the technologies those atoms do. A failure names the item and the problem, never its text.
export type TailorFailure = { item: string; problem: string };
export type TailorValidation = { ok: true } | { ok: false; failures: TailorFailure[] };

export type TailorValidateOptions = {
  // Extra names to police beyond the master's own (its skills and atoms' `how`): typically the
  // job's keywords, so a line can't claim a technology the job asks for and no atom names.
  terms?: string[];
};

export function validateTailoredResume(
  resume: TailoredResume,
  master: MasterResume,
  options: TailorValidateOptions = {},
): TailorValidation {
  const failures: TailorFailure[] = [];
  const atoms = new Map(master.atoms.map((a) => [a.id, a]));
  const roles = new Set(master.roles.map((r) => r.id));
  const vocabulary = [
    ...master.skills,
    ...master.atoms.flatMap((a) => a.how),
    ...(options.terms ?? []),
  ];

  // Citations, numbers and names of one line. `roleId` undefined: a summary line, which may cite
  // atoms from anywhere.
  const checkLine = (item: string, line: Line, roleId?: string | null) => {
    if (line.atomIds.length === 0) failures.push({ item, problem: "cites no atom" });
    const cited: MasterAtom[] = [];
    line.atomIds.forEach((id, i) => {
      const atom = atoms.get(id);
      if (!atom) {
        failures.push({ item, problem: `cites unknown atom ${i}` });
        return;
      }
      // Misplaced but real: reported, and still counted for its numbers and names, so one
      // mistake gives one failure.
      if (roleId !== undefined && atom.roleId !== roleId) {
        failures.push({ item, problem: `cites atom ${i} from another section` });
      }
      cited.push(atom);
    });
    const text = normalize(line.text);
    const allowed = new Set(cited.flatMap((a) => [...numbers(normalize(a.sourceQuote))]));
    for (const n of numbers(text)) {
      if (!allowed.has(n)) failures.push({ item, problem: `number ${n} is not in its atoms` });
    }
    const reported = new Set<string>();
    for (const term of vocabulary) {
      const key = term.toLowerCase();
      if (reported.has(key) || !mentions(text, term)) continue;
      if (!cited.some((a) => atomNames(a, term))) {
        reported.add(key);
        failures.push({ item, problem: `term ${term} is not in its atoms` });
      }
    }
  };

  resume.summary.forEach((line, i) => {
    checkLine(`summary line ${i}`, line);
  });

  // An atom is one claim: on two experience lines it would be stated twice.
  const used = new Set<string>();
  resume.sections.forEach((section, s) => {
    if (section.roleId !== null && !roles.has(section.roleId)) {
      failures.push({ item: `section ${s}`, problem: "unknown role" });
    }
    section.lines.forEach((line, l) => {
      const item = `section ${s} line ${l}`;
      checkLine(item, line, section.roleId);
      line.atomIds.forEach((id, i) => {
        if (used.has(id)) failures.push({ item, problem: `atom ${i} is already on another line` });
        used.add(id);
      });
    });
  });

  const masterSkills = new Set(master.skills.map((s) => s.toLowerCase()));
  resume.skills.forEach((skill, i) => {
    const item = `skill ${i}`;
    const cited: MasterAtom[] = [];
    skill.atomIds.forEach((id, j) => {
      const atom = atoms.get(id);
      if (atom) cited.push(atom);
      else failures.push({ item, problem: `cites unknown atom ${j}` });
    });
    if (
      !masterSkills.has(skill.name.toLowerCase()) &&
      !cited.some((a) => atomNames(a, skill.name))
    ) {
      failures.push({ item, problem: "not a master skill and not named by its atoms" });
    }
  });

  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}
