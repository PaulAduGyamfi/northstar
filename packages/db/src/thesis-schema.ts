import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { experienceAtom } from "./profile-schema.js";
import { candidate } from "./schema.js";

// The positioning thesis (DX-009, NS-127): one sentence Paul approved, versioned, citing the
// atoms that back it. Both tables are append-only (migration 0023); write them only through
// thesis-write.ts. The newest version is the current thesis.

export const positioningThesis = pgTable(
  "positioning_thesis",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    version: integer("version").notNull(),
    // Paul's approved words. Never copied into events, spans or logs.
    text: text("text").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("positioning_thesis_id_candidate_unique").on(t.id, t.candidateId),
    unique("positioning_thesis_version_unique").on(t.candidateId, t.version),
    check("positioning_thesis_version_positive", sql`${t.version} >= 1`),
    // One line of at most 200 characters (the same limit as checkThesis).
    check(
      "positioning_thesis_text_shape",
      sql`length(trim(${t.text})) between 1 and 200 and position(E'\\n' in ${t.text}) = 0`,
    ),
  ],
);

// The atoms a thesis version cites (ADR-0004).
export const positioningThesisAtom = pgTable(
  "positioning_thesis_atom",
  {
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    thesisId: uuid("thesis_id").notNull(),
    atomId: uuid("atom_id").notNull(),
  },
  (t) => [
    primaryKey({ name: "positioning_thesis_atom_pk", columns: [t.thesisId, t.atomId] }),
    foreignKey({
      name: "positioning_thesis_atom_thesis_same_candidate_fk",
      columns: [t.thesisId, t.candidateId],
      foreignColumns: [positioningThesis.id, positioningThesis.candidateId],
    }),
    foreignKey({
      name: "positioning_thesis_atom_atom_same_candidate_fk",
      columns: [t.atomId, t.candidateId],
      foreignColumns: [experienceAtom.id, experienceAtom.candidateId],
    }),
  ],
);
