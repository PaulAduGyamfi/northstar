import { normalize, numbers } from "../validate.js";
import { atomNames, jobTerms, mentions } from "./terms.js";
import type { Line, MasterAtom, MasterResume, TailoredResume, TailorJob } from "./types.js";

// The deterministic provenance check for tailored resumes (NS-117, TLR-002, ADR-0004): plain code,
// no model. Every line must rest on atoms of the master, and may only state the numbers and name
// the technologies those atoms do. A failure names the item and the problem, never a line's
// text; it may name a number or term, which come from the profile or the job, never from a line.
export type TailorFailure = { item: string; problem: string };
export type TailorValidation = { ok: true } | { ok: false; failures: TailorFailure[] };

export type TailorValidateOptions = {
  // Extra names to police beyond the master's own and those found in the job's text.
  terms?: string[];
};

// Line breaks and other control characters: one could start a fake header (a role, an
// employer) when rendered, so a line or skill must be a single line of text.
const CONTROL = /\p{Cc}/u;
// Digits outside 0-9 (Arabic-Indic, full-width…) escape the digit-token number check.
const OTHER_DIGIT = /(?![0-9])\p{Nd}/u;

export function validateTailoredResume(
  resume: TailoredResume,
  master: MasterResume,
  // Required: the job's technology names are the claims a tailored resume is most tempted to
  // make without evidence (TLR-002).
  job: TailorJob,
  options: TailorValidateOptions = {},
): TailorValidation {
  const failures: TailorFailure[] = [];
  const atoms = new Map(master.atoms.map((a) => [a.id, a]));
  const roles = new Set(master.roles.map((r) => r.id));
  const vocabulary = [
    ...master.skills,
    ...master.atoms.flatMap((a) => a.how),
    // Requirements, not the title: a title's words ("Platform Engineer") aren't claims of
    // experience, and policing them would block ordinary summary lines.
    ...jobTerms([...job.requirements, ...job.niceToHaves]),
    ...(options.terms ?? []),
  ];

  const checkText = (item: string, text: string) => {
    if (CONTROL.test(text))
      failures.push({ item, problem: "has a line break or control character" });
    if (OTHER_DIGIT.test(text)) failures.push({ item, problem: "uses digits other than 0-9" });
  };

  // Citations, numbers and names of one line. `roleId` undefined: a summary line, which may cite
  // atoms from anywhere.
  const checkLine = (item: string, line: Line, roleId?: string | null) => {
    checkText(item, line.text);
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

  // Every master role keeps exactly one section, in resume order: dropping one hides a period of
  // the work history, repeating or swapping them misstates the timeline (CPG-004).
  const sectionRoles = resume.sections.map((s) => s.roleId).filter((r): r is string => r !== null);
  const expected = master.roles.map((r) => r.id);
  if (sectionRoles.join("\n") !== expected.join("\n")) {
    expected.forEach((id, i) => {
      const count = sectionRoles.filter((r) => r === id).length;
      if (count === 0) failures.push({ item: `role ${i}`, problem: "has no section" });
      else if (count > 1)
        failures.push({ item: `role ${i}`, problem: "has more than one section" });
    });
    const known = sectionRoles.filter((r) => roles.has(r));
    const ordered = expected.filter((r) => known.includes(r));
    if ([...new Set(known)].join("\n") !== ordered.join("\n")) {
      failures.push({ item: "sections", problem: "roles are out of resume order" });
    }
  }

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
    checkText(item, skill.name);
    const cited: MasterAtom[] = [];
    skill.atomIds.forEach((id, j) => {
      const atom = atoms.get(id);
      if (atom) cited.push(atom);
      else failures.push({ item, problem: `cites unknown atom ${j}` });
    });
    const isMaster = masterSkills.has(skill.name.toLowerCase());
    if (!isMaster && !cited.some((a) => atomNames(a, skill.name))) {
      failures.push({ item, problem: "not a master skill and not named by its atoms" });
    }
    // The flag decides what Paul may toggle off (applySkillToggles): a master skill marked as
    // added could be removed from his record that way.
    if (skill.added === isMaster) {
      failures.push({ item, problem: "added flag doesn't match the master" });
    }
  });

  failures.push(...workFailures(resume, master));
  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

// The independent-work section (NS-231): every entry and line must be the stored one at the
// position it cites, verbatim, in the version the master read. A line that isn't, or a section
// with no stored work behind it, is blocked like a line with no atom (TLR-002). Failures name
// positions only, never Paul's titles or lines.
function workFailures(resume: TailoredResume, master: MasterResume): TailorFailure[] {
  const section = resume.independentWork;
  if (section === undefined) return [];
  const work = master.independentWork;
  if (!work) return [{ item: "independent work", problem: "no stored independent work" }];
  if (section.version !== work.version) {
    return [{ item: "independent work", problem: "is from another stored version" }];
  }
  const failures: TailorFailure[] = [];
  const seen = new Set<number>();
  section.entries.forEach((e, i) => {
    const item = `independent work entry ${i}`;
    const stored = work.entries[e.entry];
    if (!Number.isInteger(e.entry) || stored === undefined) {
      failures.push({ item, problem: "cites no stored entry" });
      return;
    }
    if (seen.has(e.entry)) failures.push({ item, problem: "repeats a stored entry" });
    seen.add(e.entry);
    if (e.title !== stored.title || e.start !== stored.start || e.end !== stored.end) {
      failures.push({ item, problem: "title or dates aren't the stored entry's" });
    }
    const lines = new Set<number>();
    e.lines.forEach((l, j) => {
      const at = `${item} line ${j}`;
      if (!Number.isInteger(l.line) || stored.lines[l.line] !== l.text) {
        failures.push({ item: at, problem: "isn't the stored line it cites" });
      }
      // A stored line shown twice states one claim twice, like an atom on two lines.
      if (lines.has(l.line)) failures.push({ item: at, problem: "repeats a stored line" });
      lines.add(l.line);
    });
  });
  return failures;
}
