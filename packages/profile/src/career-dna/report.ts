import { type Archetype, archetypeOf } from "./archetype.js";
import { CAREER_DNA_RUBRIC, type Rubric } from "./rubric.js";
import {
  type CareerDnaEvidence,
  type Cite,
  type DimensionScore,
  scoreDimensions,
} from "./score.js";

// The Career DNA report (NS-130, DNA-001…003) and its citation check. Every strength and label
// line cites atoms or stories; a dimension with too little evidence is a gap line with no score.

export type ReportLine =
  | { kind: "label"; text: string; cites: Cite[] }
  | { kind: "strength"; text: string; points: number; cites: Cite[] }
  // `points` is always null on a gap line built here; the check refuses any other value.
  | { kind: "gap"; text: string; points: number | null; cites: Cite[] };

export type CareerDnaReport = {
  rubricVersion: number;
  family: Rubric["family"];
  dimensions: DimensionScore[];
  archetype: Archetype | null;
  lines: ReportLine[];
};

// Only for a scored dimension, so its band is low, medium or high and it has 3+ items.
function strengthLine(d: DimensionScore & { points: number }): ReportLine {
  return {
    kind: "strength",
    text: `${d.label}: ${d.band} confidence, ${d.evidenceCount} pieces of evidence.`,
    points: d.points,
    cites: d.cites,
  };
}

export function buildCareerDna(
  evidence: CareerDnaEvidence,
  rubric: Rubric = CAREER_DNA_RUBRIC,
): CareerDnaReport {
  const dimensions = scoreDimensions(evidence, rubric);
  const archetype = archetypeOf(dimensions, rubric);
  const labels = new Map(dimensions.map((d) => [d.key, d.label]));
  const lines: ReportLine[] = [];
  if (archetype) {
    const from = archetype.dimensions.map((k) => labels.get(k) ?? k).join(" and ");
    lines.push({
      kind: "label",
      text: `${archetype.label}: from ${from}.`,
      cites: archetype.cites,
    });
  }
  for (const d of dimensions) {
    lines.push(
      d.points === null
        ? { kind: "gap", text: `${d.label}: not enough evidence yet.`, points: null, cites: [] }
        : strengthLine({ ...d, points: d.points }),
    );
  }
  return { rubricVersion: rubric.version, family: rubric.family, dimensions, archetype, lines };
}

export type CareerDnaFailure =
  | { kind: "uncited"; line: number }
  | { kind: "unknown_citation"; line: number; cite: Cite }
  | { kind: "scored_gap"; line: number };

// The DNA-001 check, run on a report before it is shown or stored: plain code, no model. `known`
// is the atoms and approved stories of Paul's current profile. Empty means it passes.
export function checkCareerDna(
  report: CareerDnaReport,
  known: { atomIds: readonly string[]; storyIds: readonly string[] },
): CareerDnaFailure[] {
  const atoms = new Set(known.atomIds);
  const stories = new Set(known.storyIds);
  const failures: CareerDnaFailure[] = [];
  report.lines.forEach((l, line) => {
    if (l.kind === "gap") {
      // A gap never shows a score: thin evidence is not a low score (DNA-002).
      if (l.points !== null) failures.push({ kind: "scored_gap", line });
    } else if (l.cites.length === 0) {
      failures.push({ kind: "uncited", line });
    }
    for (const cite of l.cites) {
      const ids = cite.kind === "atom" ? atoms : stories;
      if (!ids.has(cite.id)) failures.push({ kind: "unknown_citation", line, cite });
    }
  });
  return failures;
}
