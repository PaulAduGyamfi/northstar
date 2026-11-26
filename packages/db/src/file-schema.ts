import { sql } from "drizzle-orm";
import {
  check,
  customType,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";

// Postgres bytea as bytes (PGlite and node-postgres both hand back a Uint8Array).
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

// Files an application sends (NS-227, APPLY-001), by their SHA-256: an approved package names its
// resume by hash, and the Apply Gateway reads the bytes back at send time (`readFile`) and
// re-hashes them. Append-only (migration trigger), written only through file-write.ts. The bytes
// are Paul's resume: they stay in this table, never in an event, span or log.
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export const storedFile = pgTable(
  "stored_file",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    sha256: text("sha256").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    bytes: bytea("bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per file per candidate; the foreign key from tailored_resume needs it too.
    unique("stored_file_candidate_sha_unique").on(t.candidateId, t.sha256),
    // The database checks the hash is the bytes' own, so a row can't name other bytes.
    check("stored_file_sha256_matches", sql`${t.sha256} = encode(sha256(${t.bytes}), 'hex')`),
    check("stored_file_content_type", sql`${t.contentType} IN ('application/pdf')`),
    check("stored_file_size_matches", sql`${t.byteSize} = octet_length(${t.bytes})`),
    check(
      "stored_file_size_range",
      sql`${t.byteSize} BETWEEN 1 AND ${sql.raw(String(MAX_FILE_BYTES))}`,
    ),
  ],
);
