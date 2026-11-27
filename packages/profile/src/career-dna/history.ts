import type { CareerDnaSnapshot } from "@northstar/db";
import type { CareerDnaReport } from "./report.js";
import { CAREER_DNA_RUBRIC, type Rubric } from "./rubric.js";
import type { Band } from "./score.js";

// Career DNA history (NS-130 slice 4, DNA-008), plain code. A report is stored as a snapshot of
// its scores and cited ids (never text), and the diff says in fixed words what changed since the
// last version, so the reason to come back is the evidence, not the model.

// The stored form of a built report: each dimension's band, points, count and cited ids, in the
// rubric's order, and the archetype.
export function careerDnaSnapshot(report: CareerDnaReport): CareerDnaSnapshot {
  return {
    rubricVersion: report.rubricVersion,
    family: report.family,
    dimensions: report.dimensions.map((d) => ({
      key: d.key,
      band: d.band,
      points: d.points,
      evidenceCount: d.evidenceCount,
      atomIds: d.cites.filter((c) => c.kind === "atom").map((c) => c.id),
      storyIds: d.cites.filter((c) => c.kind === "story").map((c) => c.id),
    })),
    archetype: report.archetype && {
      label: report.archetype.label,
      dimensions: report.archetype.dimensions,
    },
  };
}

const BAND_RANK: Record<Band, number> = { not_enough: 0, low: 1, medium: 2, high: 3 };

export type DimensionChange = {
  key: string;
  direction: "up" | "down";
  fromBand: Band;
  toBand: Band;
  // Null on either side while that version had too little evidence for a score.
  fromPoints: number | null;
  toPoints: number | null;
};

export type CareerDnaDiff = {
  first: boolean;
  // A changed rubric scores differently, so its dimensions aren't compared.
  rubricChanged: boolean;
  dimensions: DimensionChange[];
  archetype: { from: string | null; to: string | null } | null;
  // Distinct cited atoms and stories, across all dimensions.
  gained: number;
  lost: number;
};

function citedIds(s: CareerDnaSnapshot): Set<string> {
  return new Set(s.dimensions.flatMap((d) => [...d.atomIds, ...d.storyIds]));
}

// What changed from the previous version to the next (null: the first report).
export function diffCareerDna(
  previous: CareerDnaSnapshot | null,
  next: CareerDnaSnapshot,
): CareerDnaDiff {
  if (previous === null) {
    return {
      first: true,
      rubricChanged: false,
      dimensions: [],
      archetype: null,
      gained: citedIds(next).size,
      lost: 0,
    };
  }
  const before = citedIds(previous);
  const after = citedIds(next);
  const gained = [...after].filter((id) => !before.has(id)).length;
  const lost = [...before].filter((id) => !after.has(id)).length;
  const fromLabel = previous.archetype?.label ?? null;
  const toLabel = next.archetype?.label ?? null;
  const archetype = fromLabel === toLabel ? null : { from: fromLabel, to: toLabel };
  const rubricChanged =
    previous.rubricVersion !== next.rubricVersion || previous.family !== next.family;
  if (rubricChanged)
    return { first: false, rubricChanged, dimensions: [], archetype, gained, lost };
  const old = new Map(previous.dimensions.map((d) => [d.key, d]));
  const dimensions: DimensionChange[] = [];
  for (const d of next.dimensions) {
    const p = old.get(d.key);
    if (!p) continue;
    // A band crossing decides the direction; within a band, the points do.
    const byBand = BAND_RANK[d.band] - BAND_RANK[p.band];
    const byPoints = (d.points ?? 0) - (p.points ?? 0);
    const delta = byBand !== 0 ? byBand : byPoints;
    if (delta === 0) continue;
    dimensions.push({
      key: d.key,
      direction: delta > 0 ? "up" : "down",
      fromBand: p.band,
      toBand: d.band,
      fromPoints: p.points,
      toPoints: d.points,
    });
  }
  return { first: false, rubricChanged, dimensions, archetype, gained, lost };
}

const BAND_WORDS: Record<Band, string> = {
  not_enough: "not enough evidence",
  low: "low",
  medium: "medium",
  high: "high",
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// The diff in fixed sentences, with the rubric's labels (never profile text).
export function changeLines(diff: CareerDnaDiff, rubric: Rubric = CAREER_DNA_RUBRIC): string[] {
  if (diff.first) return ["This is your first Career DNA report."];
  const labels = new Map(rubric.dimensions.map((d) => [d.key as string, d.label]));
  const lines: string[] = [];
  if (diff.rubricChanged) lines.push("The scoring rubric changed, so scores aren't compared.");
  if (diff.archetype) {
    lines.push(
      diff.archetype.to === null
        ? "No label fits your evidence now."
        : `Your label is now ${diff.archetype.to}.`,
    );
  }
  for (const d of diff.dimensions) {
    const label = labels.get(d.key) ?? d.key;
    lines.push(
      d.fromBand === d.toBand
        ? `${label} went ${d.direction} from ${d.fromPoints} to ${d.toPoints} points.`
        : `${label} went ${d.direction} from ${BAND_WORDS[d.fromBand]} to ${BAND_WORDS[d.toBand]}.`,
    );
  }
  if (diff.gained > 0) lines.push(`${plural(diff.gained, "new piece", "new pieces")} of evidence.`);
  if (diff.lost > 0)
    lines.push(`${plural(diff.lost, "piece", "pieces")} of evidence no longer counted.`);
  return lines.length > 0 ? lines : ["Nothing changed since your last report."];
}
