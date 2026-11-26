import { lineText } from "./tailor.js";
import type { MasterResume, TailoredResume } from "./types.js";

// What tailoring changed against the master resume (NS-117, TLR-003), for the diff view.

export type AtomChange = {
  atomId: string;
  // moved: another position within its section than in the master.
  status: "kept" | "moved" | "dropped";
  // The line's text isn't the atom's own resume line (the model route rewords; the deterministic
  // tailor never does).
  reworded: boolean;
};
export type SkillChange = { name: string; status: "added" | "kept" | "removed" };
// An independent-work entry the tailored resume adds (NS-231): the master resume has none, so
// each one is new against it. Its stored position and line count, never its title or lines.
export type WorkChange = { entry: number; lines: number };
export type ResumeDiff = { atoms: AtomChange[]; skills: SkillChange[]; work: WorkChange[] };

export function diffResume(master: MasterResume, resume: TailoredResume): ResumeDiff {
  // Where each atom sits in the tailored sections: index within its section, and its line.
  const placed = new Map<string, { index: number; text: string; alone: boolean }>();
  for (const section of resume.sections) {
    section.lines.forEach((line, index) => {
      for (const id of line.atomIds) {
        if (!placed.has(id))
          placed.set(id, { index, text: line.text, alone: line.atomIds.length === 1 });
      }
    });
  }
  const atoms = master.atoms.map((atom): AtomChange => {
    const at = placed.get(atom.id);
    if (!at) return { atomId: atom.id, status: "dropped", reworded: false };
    // The master's order within the same section, counting only atoms still in the resume, so a
    // drop above an atom doesn't count as moving it.
    const kept = master.atoms.filter((a) => a.roleId === atom.roleId && placed.has(a.id));
    const before = kept.findIndex((a) => a.id === atom.id);
    return {
      atomId: atom.id,
      status: before === at.index ? "kept" : "moved",
      // A line merging several atoms is a rewording of each.
      reworded: !at.alone || at.text !== lineText(atom),
    };
  });
  const masterSkills = new Set(master.skills.map((s) => s.toLowerCase()));
  const present = new Set(resume.skills.map((s) => s.name.toLowerCase()));
  const skills: SkillChange[] = [
    ...resume.skills.map(
      (s): SkillChange => ({
        name: s.name,
        status: masterSkills.has(s.name.toLowerCase()) ? "kept" : "added",
      }),
    ),
    ...master.skills
      .filter((s) => !present.has(s.toLowerCase()))
      .map((name): SkillChange => ({ name, status: "removed" })),
  ];
  const work = (resume.independentWork?.entries ?? []).map(
    (e): WorkChange => ({ entry: e.entry, lines: e.lines.length }),
  );
  return { atoms, skills, work };
}

// The keep/remove toggles on added skills (TLR-003): the resume without the added skills Paul
// turned off, matched ignoring case. Master skills are his record, not a tailoring choice, so a
// toggle naming one (or naming nothing in the resume) is refused. The error gives the toggle's
// position, never the skill.
export function applySkillToggles(resume: TailoredResume, remove: string[]): TailoredResume {
  const added = new Set(resume.skills.filter((s) => s.added).map((s) => s.name.toLowerCase()));
  remove.forEach((name, i) => {
    if (!added.has(name.toLowerCase())) throw new Error(`toggle ${i} is not an added skill`);
  });
  const off = new Set(remove.map((n) => n.toLowerCase()));
  return { ...resume, skills: resume.skills.filter((s) => !off.has(s.name.toLowerCase())) };
}
