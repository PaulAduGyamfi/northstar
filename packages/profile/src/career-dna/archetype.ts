import { CAREER_DNA_RUBRIC, type DimensionKey, type Rubric } from "./rubric.js";
import type { Cite, DimensionScore } from "./score.js";

// The archetype label (NS-130, DNA-003): a fixed mapping over the top dimensions, so the label
// follows from the scores and never from a model. Labels name the kind of work, never a
// personality trait the evidence can't back, and never a job title ("Lead", "Engineer",
// "Architect"): titles are locked facts (ADR-0004), and the evidence doesn't prove Paul held one.

export type Archetype = {
  label: string;
  // The one or two dimensions it comes from, most points first.
  dimensions: string[];
  // "Why this label": both dimensions' evidence, in that order.
  cites: Cite[];
};

const SINGLE: Record<DimensionKey, string> = {
  engineering: "The Builder",
  architecture: "The System Shaper",
  infrastructure: "The Operator",
  leadership: "The Team Organizer",
  communication: "The Communicator",
  problem_solving: "The Problem Solver",
};

// One label per unordered pair, keyed in rubric order ("engineering+architecture").
const PAIR: Record<string, string> = {
  "engineering+architecture": "The Systems Builder",
  "engineering+infrastructure": "The Platform Builder",
  "engineering+leadership": "The Hands-On Organizer",
  "engineering+communication": "The Product Builder",
  "engineering+problem_solving": "The Hands-On Problem Solver",
  "architecture+infrastructure": "The Platform Shaper",
  "architecture+leadership": "The Architecture Driver",
  "architecture+communication": "The Systems Explainer",
  "architecture+problem_solving": "The Systems Troubleshooter",
  "infrastructure+leadership": "The Operations Driver",
  "infrastructure+communication": "The Platform Partner",
  "infrastructure+problem_solving": "The Reliability Fixer",
  "leadership+communication": "The Team Connector",
  "leadership+problem_solving": "The Delivery Driver",
  "communication+problem_solving": "The Cross-Team Problem Solver",
};

export function archetypeOf(
  scores: DimensionScore[],
  rubric: Rubric = CAREER_DNA_RUBRIC,
): Archetype | null {
  const order = rubric.dimensions.map((d) => d.key as string);
  // Only dimensions with a score; most points first, a tie by rubric order.
  const top = scores
    .filter((s): s is DimensionScore & { points: number } => s.points !== null)
    .filter((s) => order.includes(s.key))
    .sort((a, b) => b.points - a.points || order.indexOf(a.key) - order.indexOf(b.key))
    .slice(0, 2);
  const [first, second] = top;
  if (!first) return null;
  const label = second
    ? PAIR[[first.key, second.key].sort((a, b) => order.indexOf(a) - order.indexOf(b)).join("+")]
    : SINGLE[first.key as DimensionKey];
  // Every pair of rubric keys is in the table (a test); a missing one gives no label.
  if (label === undefined) return null;
  return {
    label,
    dimensions: top.map((s) => s.key),
    cites: top.flatMap((s) => s.cites),
  };
}
