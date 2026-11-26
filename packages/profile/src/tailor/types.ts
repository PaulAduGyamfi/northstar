import { z } from "zod";
import type { WorkEntry } from "../independent-work.js";

// Resume tailoring (NS-117, TLR-001…004). The master resume is the profile graph's records; the
// tailored resume only arranges and cites them (ADR-0004).

export type MasterRole = {
  id: string;
  employer: string;
  title: string;
  startMonth: string | null;
  endMonth: string | null;
  isCurrent: boolean;
};

export type MasterEducation = {
  school: string;
  degree: string | null;
  field: string | null;
  endMonth: string | null;
};

export type MasterAtom = {
  id: string;
  // null for a project or other line outside any role.
  roleId: string | null;
  what: string;
  how: string[];
  // The exact resume line the atom came from (NS-110).
  sourceQuote: string;
};

// Paul's independent work since his last role (NS-196): the newest stored version of his own
// file, entries and lines in file order. It has no resume line to quote, so its provenance is
// the stored entry and line, not an atom (NS-231, DX-010).
export type MasterWork = { version: number; entries: WorkEntry[] };

// Roles, education and atoms in resume order, and the independent work when there is any.
export type MasterResume = {
  roles: MasterRole[];
  education: MasterEducation[];
  atoms: MasterAtom[];
  skills: string[];
  independentWork?: MasterWork | null;
};

// The independent-work part of a tailored resume (NS-231). Each line cites its stored entry and
// line by position in that version, and is that line verbatim (validateTailoredResume checks).
export type WorkSection = {
  version: number;
  entries: {
    entry: number;
    title: string;
    start: string;
    end: string | null;
    lines: { line: number; text: string }[];
  }[];
};

// What tailoring reads from a job (the fields `jobs add` stores).
export type TailorJob = {
  title: string | null;
  requirements: string[];
  niceToHaves: string[];
};

// A line of the resume and the atoms it rests on. At least one: a line with no atom behind it
// is blocked (TLR-002). Zod, because the model route will return this shape.
// One line of text: a line break could start a fake header (a role, an employer) when rendered.
const OneLine = z
  .string()
  .min(1)
  .refine((t) => !/\p{Cc}/u.test(t), "must be one line without control characters");

const Line = z.object({
  text: OneLine,
  atomIds: z.array(z.string().min(1)).min(1),
});
export type Line = z.infer<typeof Line>;

export const TailoredResume = z.object({
  summary: z.array(Line),
  // A role's section names the role by id only: employer, title and dates come from the master
  // when rendering, so tailoring can never change a locked fact (CPG-004). roleId null is the
  // projects section.
  sections: z.array(z.object({ roleId: z.string().min(1).nullable(), lines: z.array(Line) })),
  // A skill the master lists cites nothing; one it doesn't list (added) cites the atoms proving it.
  skills: z.array(
    z.object({ name: OneLine, atomIds: z.array(z.string().min(1)), added: z.boolean() }),
  ),
  // "not claimed: Kubernetes (no evidence)": requirements nothing in the profile meets.
  notClaimed: z.array(z.string()),
});
// The type adds the independent-work section, which only the deterministic tailor fills from the
// master. The Zod schema doesn't: it is the model route's output, and parsing drops unknown keys,
// so a model can never put a section in (and the route's recorded requests stay the same).
export type TailoredResume = z.infer<typeof TailoredResume> & { independentWork?: WorkSection };
