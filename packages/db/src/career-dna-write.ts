import { createHash } from "node:crypto";
import type { CandidateId } from "@northstar/domain";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type CareerDnaDimensionSnapshot, careerDnaReport } from "./career-dna-schema.js";
import type { Db } from "./db.js";
import { appendEvent, inSpan } from "./resilience-event.js";

// Career DNA report history (NS-130 slice 4, DNA-008). A report is stored as a snapshot of its
// scores and cited ids, a new version only when it differs from the newest one, so a rebuild after
// an unrelated profile change stores nothing. Ids, numbers and fixed labels only: atom and story
// text never reaches this table, an event or a span.

// The history read returns at most this many versions.
export const CAREER_DNA_HISTORY_LIMIT = 20;

const Id = z.uuid();
// A rubric's own key or label: fixed words, never profile text.
const Key = z.string().regex(/^[a-z_]{1,40}$/);

export const CareerDnaSnapshot = z
  .object({
    rubricVersion: z.number().int().min(1),
    family: Key,
    dimensions: z
      .array(
        z
          .object({
            key: Key,
            band: z.enum(["not_enough", "low", "medium", "high"]),
            points: z.number().int().min(0).max(10_000).nullable(),
            evidenceCount: z.number().int().min(0).max(10_000),
            atomIds: z.array(Id).max(5_000),
            storyIds: z.array(Id).max(5_000),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    archetype: z
      .object({
        // The rubric's fixed labels ("The Systems Builder"): letters, spaces and hyphens only.
        label: z.string().regex(/^[A-Za-z][A-Za-z -]{0,59}$/),
        dimensions: z.array(Key).min(1).max(2),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type CareerDnaSnapshot = z.infer<typeof CareerDnaSnapshot>;

export type StoredCareerDna = CareerDnaSnapshot & { id: string; version: number; createdAt: Date };

export type SaveCareerDnaError = { kind: "InvalidReport"; fields: string[] };

// The snapshot's hash over a fixed key order, so equal snapshots hash the same.
function snapshotSha256(s: CareerDnaSnapshot): string {
  const canonical = {
    rubricVersion: s.rubricVersion,
    family: s.family,
    dimensions: s.dimensions.map((d) => ({
      key: d.key,
      band: d.band,
      points: d.points,
      evidenceCount: d.evidenceCount,
      atomIds: d.atomIds,
      storyIds: d.storyIds,
    })),
    archetype: s.archetype && { label: s.archetype.label, dimensions: s.archetype.dimensions },
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// Stores the report as a new version unless it equals the newest one. Writers lock the candidate
// row, so two saves can't take the same version or both store one report.
export async function saveCareerDnaReport(
  db: Db,
  input: { candidateId: CandidateId; snapshot: unknown },
): Promise<
  | { ok: true; value: { stored: boolean; version: number; reportId: string } }
  | { ok: false; error: SaveCareerDnaError }
> {
  const parsed = CareerDnaSnapshot.safeParse(input.snapshot);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "snapshot")))];
    return { ok: false, error: { kind: "InvalidReport", fields } };
  }
  const s = parsed.data;
  const sha = snapshotSha256(s);
  return inSpan("db.career_dna.save", { "northstar.career_dna.rubric": s.rubricVersion }, (span) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select id from candidate where id = ${input.candidateId} for update`);
      const [newest] = await tx
        .select({
          id: careerDnaReport.id,
          version: careerDnaReport.version,
          sha: careerDnaReport.contentSha256,
        })
        .from(careerDnaReport)
        .where(eq(careerDnaReport.candidateId, input.candidateId))
        .orderBy(desc(careerDnaReport.version))
        .limit(1);
      if (newest?.sha === sha) {
        return {
          ok: true as const,
          value: { stored: false, version: newest.version, reportId: newest.id },
        };
      }
      const version = (newest?.version ?? 0) + 1;
      const dimensions: CareerDnaDimensionSnapshot[] = s.dimensions;
      const [row] = await tx
        .insert(careerDnaReport)
        .values({
          candidateId: input.candidateId,
          version,
          rubricVersion: s.rubricVersion,
          family: s.family,
          dimensions,
          archetypeLabel: s.archetype?.label ?? null,
          archetypeDimensions: s.archetype?.dimensions ?? [],
          contentSha256: sha,
        })
        .returning({ id: careerDnaReport.id, createdAt: careerDnaReport.createdAt });
      if (!row) throw new Error("career_dna_report insert returned no row");
      span.setAttribute("northstar.career_dna.version", version);
      await appendEvent(tx, span, {
        candidateId: input.candidateId,
        aggregate: `career_dna_report:${row.id}`,
        type: "career_dna.saved",
        actor: "system",
        // Fixed words only: the feed shows this sentence.
        reason: "Updated your Career DNA report",
        // The version and a count only: never a cited id or any text.
        payload: { reportId: row.id, version, dimensions: s.dimensions.length },
        idempotencyKey: `career_dna_report:${row.id}`,
        at: row.createdAt,
      });
      return { ok: true as const, value: { stored: true, version, reportId: row.id } };
    }),
  );
}

// The candidate's report versions, newest first.
export async function readCareerDnaHistory(
  db: Db,
  candidateId: CandidateId,
): Promise<StoredCareerDna[]> {
  const rows = await db
    .select()
    .from(careerDnaReport)
    .where(eq(careerDnaReport.candidateId, candidateId))
    .orderBy(desc(careerDnaReport.version))
    .limit(CAREER_DNA_HISTORY_LIMIT);
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    createdAt: r.createdAt,
    rubricVersion: r.rubricVersion,
    family: r.family,
    dimensions: r.dimensions,
    archetype:
      r.archetypeLabel === null
        ? null
        : { label: r.archetypeLabel, dimensions: r.archetypeDimensions },
  }));
}
