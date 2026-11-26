import { createHash } from "node:crypto";
import type { CandidateId } from "@northstar/domain";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "./db.js";
import {
  independentWorkEntry,
  independentWorkLine,
  independentWorkSet,
} from "./independent-work-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";

// The independent-work entries' only write path (NS-196, DX-010). The caller parses Paul's file
// with parseIndependentWork (packages/profile) first; this stores the whole list as a new version.
// The event carries the version and counts only, never a title, line or link.

export type IndependentWorkInput = {
  title: string;
  // YYYY-MM.
  start: string;
  // YYYY-MM, or null while ongoing.
  end: string | null;
  link: string | null;
  lines: string[];
};

export type SetIndependentWorkResult = {
  status: "set" | "unchanged";
  version: number;
  entries: number;
  lines: number;
};

export type IndependentWorkView = {
  version: number;
  createdAt: Date;
  entries: IndependentWorkInput[];
};

// The stored shape's fingerprint: field by field, in file order, so the same list is the same.
function contentSha256(entries: readonly IndependentWorkInput[]): string {
  const canonical = entries.map((e) => [e.title, e.start, e.end, e.link, e.lines]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// Stores Paul's list as the next version, in one transaction. The same list as the newest
// version stores nothing (safe to repeat). Two runs racing for one version: the unique constraint
// fails one, and nothing is half-stored.
export async function setIndependentWork(
  db: Db,
  input: { candidateId: CandidateId; entries: readonly IndependentWorkInput[] },
): Promise<SetIndependentWorkResult> {
  const lineCount = input.entries.reduce((n, e) => n + e.lines.length, 0);
  const sha = contentSha256(input.entries);
  try {
    return await inSpan(
      "independent_work.set",
      { "northstar.work.entries": input.entries.length, "northstar.work.lines": lineCount },
      (span) =>
        db.transaction(async (tx) => {
          const [latest] = await tx
            .select({ version: independentWorkSet.version, sha: independentWorkSet.contentSha256 })
            .from(independentWorkSet)
            .where(eq(independentWorkSet.candidateId, input.candidateId))
            .orderBy(desc(independentWorkSet.version))
            .limit(1);
          const counts = { entries: input.entries.length, lines: lineCount };
          if (latest && latest.sha === sha) {
            return { status: "unchanged" as const, version: latest.version, ...counts };
          }
          const version = (latest?.version ?? 0) + 1;
          const [set] = await tx
            .insert(independentWorkSet)
            .values({ candidateId: input.candidateId, version, contentSha256: sha })
            .returning({ id: independentWorkSet.id, createdAt: independentWorkSet.createdAt });
          if (!set) throw new Error("independent_work_set insert returned no row");
          for (const [position, e] of input.entries.entries()) {
            const [entry] = await tx
              .insert(independentWorkEntry)
              .values({
                candidateId: input.candidateId,
                setId: set.id,
                position,
                title: e.title,
                startedOn: e.start,
                endedOn: e.end,
                link: e.link,
              })
              .returning({ id: independentWorkEntry.id });
            if (!entry) throw new Error("independent_work_entry insert returned no row");
            await tx.insert(independentWorkLine).values(
              e.lines.map((text, i) => ({
                candidateId: input.candidateId,
                entryId: entry.id,
                position: i,
                text,
              })),
            );
          }
          await appendEvent(tx, span, {
            candidateId: input.candidateId,
            aggregate: `independent_work_set:${set.id}`,
            type: "independent_work.set",
            actor: "user",
            reason: "Paul updated his independent work",
            payload: { setId: set.id, version, ...counts },
            idempotencyKey: `independent-work-set:${set.id}`,
            at: set.createdAt,
          });
          return { status: "set" as const, version, ...counts };
        }),
    );
  } catch {
    // A fresh error with no cause: the driver's message lists the query's parameters, which are
    // Paul's titles and lines (a refused shape, a lost connection, or a lost version race).
    throw new Error("independent_work.set failed");
  }
}

// The newest version with its entries and lines in file order, or null before the first.
export async function readIndependentWork(
  db: Db,
  candidateId: CandidateId,
): Promise<IndependentWorkView | null> {
  const [set] = await db
    .select()
    .from(independentWorkSet)
    .where(eq(independentWorkSet.candidateId, candidateId))
    .orderBy(desc(independentWorkSet.version))
    .limit(1);
  if (!set) return null;
  const entries = await db
    .select()
    .from(independentWorkEntry)
    .where(
      and(
        eq(independentWorkEntry.candidateId, candidateId),
        eq(independentWorkEntry.setId, set.id),
      ),
    )
    .orderBy(asc(independentWorkEntry.position));
  const lines =
    entries.length === 0
      ? []
      : await db
          .select()
          .from(independentWorkLine)
          .where(
            and(
              eq(independentWorkLine.candidateId, candidateId),
              inArray(
                independentWorkLine.entryId,
                entries.map((e) => e.id),
              ),
            ),
          )
          .orderBy(asc(independentWorkLine.position));
  return {
    version: set.version,
    createdAt: set.createdAt,
    entries: entries.map((e) => ({
      title: e.title,
      start: e.startedOn,
      end: e.endedOn,
      link: e.link,
      lines: lines.filter((l) => l.entryId === e.id).map((l) => l.text),
    })),
  };
}
