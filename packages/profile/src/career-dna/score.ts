import type { Competency } from "@northstar/db";
import { hasWhole, normalize } from "../validate.js";
import { CAREER_DNA_RUBRIC, type Rubric } from "./rubric.js";

// Scoring the rubric's dimensions from Paul's evidence (NS-130, DNA-002). Plain code: each
// dimension's points are the sum of what its cited items are worth, so removing one cited atom
// lowers them by exactly the rubric's atom points.

export type CareerDnaAtom = { id: string; what: string; how: string[]; sourceQuote: string };
// An approved story (stories are stored only once Paul approves them).
export type CareerDnaStory = { id: string; competencies: readonly Competency[] };
export type CareerDnaEvidence = { atoms: CareerDnaAtom[]; stories: CareerDnaStory[] };

export type Cite = { kind: "atom" | "story"; id: string };
export type Band = "not_enough" | "low" | "medium" | "high";

export type DimensionScore = {
  key: string;
  label: string;
  band: Band;
  // null under the `low` band: thin evidence shows no score at all.
  points: number | null;
  evidenceCount: number;
  // Atoms first, in the order given, then stories.
  cites: Cite[];
};

function bandOf(count: number, bands: Rubric["bands"]): Band {
  if (count >= bands.high) return "high";
  if (count >= bands.medium) return "medium";
  if (count >= bands.low) return "low";
  return "not_enough";
}

// The text an atom's terms are matched in, lower-cased so a term matches whatever its case.
function atomText(a: CareerDnaAtom): string {
  return normalize([a.what, ...a.how, a.sourceQuote].join(" ")).toLowerCase();
}

function unique<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => !seen.has(i.id) && seen.add(i.id) !== undefined);
}

export function scoreDimensions(
  evidence: CareerDnaEvidence,
  rubric: Rubric = CAREER_DNA_RUBRIC,
): DimensionScore[] {
  // An id given twice is one item: the evidence count is distinct atoms and stories.
  const texts = unique(evidence.atoms).map((a) => ({ id: a.id, text: atomText(a) }));
  const allStories = unique(evidence.stories);
  return rubric.dimensions.map((d) => {
    // Each item counts once per dimension, however many of its terms or tags match.
    const atoms = texts.filter((a) => d.terms.some((t) => hasWhole(a.text, t)));
    const stories = allStories.filter((s) =>
      s.competencies.some((c) => d.competencies.includes(c)),
    );
    const count = atoms.length + stories.length;
    const band = bandOf(count, rubric.bands);
    const points = atoms.length * rubric.atomPoints + stories.length * rubric.storyPoints;
    return {
      key: d.key,
      label: d.label,
      band,
      points: band === "not_enough" ? null : points,
      evidenceCount: count,
      cites: [
        ...atoms.map((a): Cite => ({ kind: "atom", id: a.id })),
        ...stories.map((s): Cite => ({ kind: "story", id: s.id })),
      ],
    };
  });
}
