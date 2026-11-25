import type { CandidateId } from "@northstar/domain";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "./db.js";
import { experienceAtom, profileSource } from "./profile-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import { positioningThesis, positioningThesisAtom } from "./thesis-schema.js";

// The positioning thesis's only write path (DX-009, NS-127). The caller runs checkThesis
// (packages/profile) and shows Paul the result first; this stores what he approved. Its event
// carries the version and the atom count, never the text.

export type SaveThesisResult =
  | { ok: true; version: number; saved: boolean }
  | {
      ok: false;
      error:
        | { kind: "NoAtoms" }
        | { kind: "BadShape" }
        | { kind: "AtomNotCurrent"; atomIds: string[] };
    };

// The database CHECK's shape (1 to 200 characters after trimming, no CR or LF), checked here
// first so a bad text is a typed refusal, never a database error carrying Paul's words.
const MAX_THESIS = 200;
const goodShape = (text: string) =>
  text.length >= 1 && text.length <= MAX_THESIS && !/[\r\n]/.test(text);

export async function saveApprovedThesis(
  db: Db,
  input: { candidateId: CandidateId; text: string; atomIds: string[] },
): Promise<SaveThesisResult> {
  const atomIds = [...new Set(input.atomIds)];
  if (atomIds.length === 0) return { ok: false, error: { kind: "NoAtoms" } };
  const text = input.text.trim();
  if (!goodShape(text)) return { ok: false, error: { kind: "BadShape" } };
  try {
    return await save(db, input.candidateId, text, atomIds);
  } catch {
    // A fresh error with no cause: the driver's message lists the query's parameters, which
    // include the thesis text (a lost connection, or two saves racing for one version).
    throw new Error("thesis.save failed");
  }
}

async function save(
  db: Db,
  candidateId: CandidateId,
  text: string,
  atomIds: string[],
): Promise<SaveThesisResult> {
  return inSpan("thesis.save", { "northstar.thesis.atoms": atomIds.length }, (span) =>
    db.transaction(async (tx) => {
      // Only atoms of Paul's current resume import may back his thesis.
      const current = await tx
        .select({ id: experienceAtom.id })
        .from(experienceAtom)
        .innerJoin(profileSource, eq(profileSource.id, experienceAtom.sourceId))
        .where(
          and(
            eq(experienceAtom.candidateId, candidateId),
            // The resume only (NS-133): a LinkedIn import is also a current source.
            eq(profileSource.kind, "resume"),
            isNull(profileSource.supersededAt),
            inArray(experienceAtom.id, atomIds),
          ),
        );
      const found = new Set(current.map((a) => a.id));
      const missing = atomIds.filter((id) => !found.has(id));
      if (missing.length > 0)
        return { ok: false, error: { kind: "AtomNotCurrent", atomIds: missing } };

      const [latest] = await tx
        .select({
          id: positioningThesis.id,
          version: positioningThesis.version,
          text: positioningThesis.text,
        })
        .from(positioningThesis)
        .where(eq(positioningThesis.candidateId, candidateId))
        .orderBy(desc(positioningThesis.version))
        .limit(1);
      // The same words citing the same atoms are not a new version. New atoms (say after a
      // resume re-import) are: the citations are part of what Paul approved.
      if (latest && latest.text === text) {
        const cited = await tx
          .select({ atomId: positioningThesisAtom.atomId })
          .from(positioningThesisAtom)
          .where(eq(positioningThesisAtom.thesisId, latest.id));
        const same =
          cited.length === atomIds.length && cited.every((c) => atomIds.includes(c.atomId));
        if (same) return { ok: true, version: latest.version, saved: false };
      }
      // Two saves racing for the same version: the unique constraint fails one, nothing doubles.
      const version = (latest?.version ?? 0) + 1;
      const [row] = await tx
        .insert(positioningThesis)
        .values({ candidateId: candidateId, version, text })
        .returning({ id: positioningThesis.id, approvedAt: positioningThesis.approvedAt });
      if (!row) throw new Error("positioning_thesis insert returned no row");
      await tx
        .insert(positioningThesisAtom)
        .values(atomIds.map((atomId) => ({ candidateId: candidateId, thesisId: row.id, atomId })));
      await appendEvent(tx, span, {
        candidateId: candidateId,
        aggregate: `positioning_thesis:${row.id}`,
        type: "thesis.approved",
        actor: "user",
        reason: "Paul approved a positioning thesis",
        payload: { thesisId: row.id, version, atomCount: atomIds.length },
        idempotencyKey: `thesis-approved:${row.id}`,
        at: row.approvedAt,
      });
      return { ok: true, version, saved: true };
    }),
  );
}

export type ThesisView = { version: number; text: string; atomIds: string[]; approvedAt: Date };

async function withAtoms(
  db: Db,
  candidateId: CandidateId,
  rows: (typeof positioningThesis.$inferSelect)[],
): Promise<ThesisView[]> {
  if (rows.length === 0) return [];
  const links = await db
    .select()
    .from(positioningThesisAtom)
    .where(
      and(
        eq(positioningThesisAtom.candidateId, candidateId),
        inArray(
          positioningThesisAtom.thesisId,
          rows.map((r) => r.id),
        ),
      ),
    );
  return rows.map((r) => ({
    version: r.version,
    text: r.text,
    atomIds: links.filter((l) => l.thesisId === r.id).map((l) => l.atomId),
    approvedAt: r.approvedAt,
  }));
}

// The current thesis (newest version), or null before Paul approves one.
export async function readCurrentThesis(
  db: Db,
  candidateId: CandidateId,
): Promise<ThesisView | null> {
  const rows = await db
    .select()
    .from(positioningThesis)
    .where(eq(positioningThesis.candidateId, candidateId))
    .orderBy(desc(positioningThesis.version))
    .limit(1);
  return (await withAtoms(db, candidateId, rows))[0] ?? null;
}

// Every version, newest first.
export async function readThesisHistory(db: Db, candidateId: CandidateId): Promise<ThesisView[]> {
  const rows = await db
    .select()
    .from(positioningThesis)
    .where(eq(positioningThesis.candidateId, candidateId))
    .orderBy(desc(positioningThesis.version));
  return withAtoms(db, candidateId, rows);
}
