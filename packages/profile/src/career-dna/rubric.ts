import type { Competency } from "@northstar/db";

// The Career DNA rubric (NS-130, DNA-002): fixed and versioned, so the same profile always gets
// the same scores and a change to the rubric is a new version, never a silent re-weighting. Code
// sets every score; a model may later word the report but never touches a number.

export type DimensionKey =
  | "engineering"
  | "architecture"
  | "infrastructure"
  | "leadership"
  | "communication"
  | "problem_solving";

export type RubricDimension = {
  key: DimensionKey;
  label: string;
  // Whole words or phrases, matched case-blind against an atom's `what`, `how` and resume line.
  terms: readonly string[];
  // Approved stories tagged with any of these count toward the dimension.
  competencies: readonly Competency[];
};

export type Rubric = {
  version: number;
  family: "software_engineering";
  dimensions: readonly RubricDimension[];
  // What one cited item is worth. A story is worth more: Paul approved it and it has all four
  // STAR parts, where an atom is one resume line.
  atomPoints: number;
  storyPoints: number;
  // Distinct cited items needed for each band. Under `low`, the dimension reads "not enough
  // evidence yet" and shows no score (DNA-002: thin evidence is never a low score).
  bands: { low: number; medium: number; high: number };
};

// Version 1: DNA-002's own example dimensions, for software engineering roles only. Defaults an
// agent picked under Paul's delegation (NS-130 spec, open questions); a change is version 2.
export const CAREER_DNA_RUBRIC: Rubric = {
  version: 1,
  family: "software_engineering",
  dimensions: [
    {
      key: "engineering",
      label: "Engineering",
      terms: ["built", "implemented", "developed", "shipped", "coded", "refactored", "tested"],
      competencies: ["technical-depth"],
    },
    {
      key: "architecture",
      label: "Architecture",
      terms: [
        "designed",
        "architected",
        "architecture",
        "system design",
        "schema",
        "api",
        "distributed",
        "event-driven",
        "migrated",
      ],
      competencies: ["scale"],
    },
    {
      key: "infrastructure",
      label: "Infrastructure",
      terms: [
        "deployed",
        "infrastructure",
        "kubernetes",
        "docker",
        "terraform",
        "aws",
        "gcp",
        "azure",
        "ci/cd",
        "pipeline",
        "monitoring",
        "on-call",
        "uptime",
      ],
      competencies: [],
    },
    {
      key: "leadership",
      label: "Leadership",
      terms: ["led", "mentored", "managed", "hired", "coordinated", "owned"],
      competencies: ["leadership", "ownership"],
    },
    {
      key: "communication",
      label: "Communication",
      terms: ["presented", "documented", "trained", "partnered", "stakeholders", "wrote"],
      competencies: ["collaboration", "conflict", "customer-impact"],
    },
    {
      key: "problem_solving",
      label: "Problem-solving",
      terms: ["debugged", "diagnosed", "resolved", "fixed", "investigated", "optimized", "reduced"],
      competencies: ["ambiguity", "failure"],
    },
  ],
  atomPoints: 1,
  storyPoints: 2,
  bands: { low: 3, medium: 6, high: 10 },
};
