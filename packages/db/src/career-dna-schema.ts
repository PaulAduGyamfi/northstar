import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";

// Career DNA report versions (NS-130 slice 4, DNA-008): one row per version per candidate, the
// newest is current. A row is a snapshot of the scores only: the rubric version, each dimension's
// band, points, evidence count and cited atom and story ids, and the archetype. Never atom or story
// text, and never the report's sentences, which are rebuilt from the snapshot and the rubric.
// Append-only (migration trigger), written only through career-dna-write.ts.

export type CareerDnaDimensionSnapshot = {
  key: string;
  band: "not_enough" | "low" | "medium" | "high";
  points: number | null;
  evidenceCount: number;
  atomIds: string[];
  storyIds: string[];
};

export const careerDnaReport = pgTable(
  "career_dna_report",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    // 1, 2, … per candidate; the highest is the current report.
    version: integer("version").notNull(),
    rubricVersion: integer("rubric_version").notNull(),
    family: text("family").notNull(),
    // In the rubric's order.
    dimensions: jsonb("dimensions").$type<CareerDnaDimensionSnapshot[]>().notNull(),
    // Null when no dimension had enough evidence for a label.
    archetypeLabel: text("archetype_label"),
    archetypeDimensions: jsonb("archetype_dimensions").$type<string[]>().notNull(),
    // SHA-256 of the canonical snapshot: the same report saved again stores nothing.
    contentSha256: text("content_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("career_dna_report_version_once").on(t.candidateId, t.version),
    check("career_dna_report_version_positive", sql`${t.version} >= 1`),
    check("career_dna_report_rubric_version_positive", sql`${t.rubricVersion} >= 1`),
    check("career_dna_report_family_shape", sql`${t.family} ~ '^[a-z_]{1,40}$'`),
    check("career_dna_report_sha256_shape", sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "career_dna_report_archetype_shape",
      // A label comes with the one or two dimensions it is from; no label, no dimensions.
      sql`(${t.archetypeLabel} is null and jsonb_array_length(${t.archetypeDimensions}) = 0) or (char_length(${t.archetypeLabel}) between 1 and 60 and jsonb_array_length(${t.archetypeDimensions}) between 1 and 2)`,
    ),
    check(
      "career_dna_report_lists_shape",
      sql`jsonb_typeof(${t.dimensions}) = 'array' and jsonb_array_length(${t.dimensions}) between 1 and 20 and jsonb_typeof(${t.archetypeDimensions}) = 'array' and jsonb_array_length(${t.archetypeDimensions}) <= 2`,
    ),
  ],
);
