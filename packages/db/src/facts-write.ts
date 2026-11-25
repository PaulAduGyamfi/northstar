import { randomUUID } from "node:crypto";
import type { CandidateId } from "@northstar/domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { employmentFact } from "./profile-schema.js";
import { domainEvent } from "./schema.js";

// One position in Paul's official employment record (DX-011). Dates are "YYYY-MM" or "YYYY-MM-DD";
// endDate is null exactly when the position is current.
export type OfficialPosition = {
  employer: string;
  title: string;
  startDate: string;
  endDate: string | null;
  current: boolean;
};

export type SetFactsResult = { status: "set" | "unchanged"; positions: number };

// Replaces the official record in one transaction: the current rows are marked superseded (kept
// for history) and the new ones inserted, with one profile.facts_set event holding a count only.
// Setting the same record again changes nothing (RES-006).
export async function setEmploymentFacts(
  db: Db,
  input: { candidateId: CandidateId; positions: OfficialPosition[] },
): Promise<SetFactsResult> {
  // An empty file must not silently erase the source of truth.
  if (input.positions.length === 0) throw new Error("official record has no positions");
  return db.transaction(async (tx) => {
    const current = await readEmploymentFacts(tx, input.candidateId);
    const positions = input.positions.length;
    // Compares the whole record field by field, in file order.
    const same =
      current.length === input.positions.length &&
      current.every((c, i) => {
        const p = input.positions[i];
        return (
          p !== undefined &&
          c.employer === p.employer &&
          c.title === p.title &&
          c.startDate === p.startDate &&
          c.endDate === p.endDate &&
          c.current === p.current
        );
      });
    if (same) {
      return { status: "unchanged", positions };
    }
    await tx
      .update(employmentFact)
      .set({ supersededAt: sql`now()` })
      .where(
        and(eq(employmentFact.candidateId, input.candidateId), isNull(employmentFact.supersededAt)),
      );
    const rows = await tx
      .insert(employmentFact)
      .values(
        input.positions.map((p, position) => ({
          candidateId: input.candidateId,
          employer: p.employer,
          title: p.title,
          startDate: p.startDate,
          endDate: p.endDate,
          isCurrent: p.current,
          position,
        })),
      )
      .returning({ id: employmentFact.id });
    await tx.insert(domainEvent).values({
      id: randomUUID(),
      candidateId: input.candidateId,
      aggregate: `candidate:${input.candidateId}`,
      type: "profile.facts_set",
      actor: "user",
      reason: "Official employment record set",
      inputsSummary: "",
      // A count only: employers, titles and dates are Paul's facts and stay in their table.
      payload: { positions },
      links: [],
      traceId: null,
      // Keyed by the first new row, so setting an older record again later is a new event.
      idempotencyKey: `facts-set:${rows[0]?.id ?? randomUUID()}`,
      occurredAt: new Date(),
    });
    return { status: "set", positions };
  });
}

// The current official record, in the order of Paul's file.
export async function readEmploymentFacts(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
): Promise<OfficialPosition[]> {
  const rows = await db
    .select()
    .from(employmentFact)
    .where(and(eq(employmentFact.candidateId, candidateId), isNull(employmentFact.supersededAt)))
    .orderBy(employmentFact.position);
  return rows.map((r) => ({
    employer: r.employer,
    title: r.title,
    startDate: r.startDate,
    endDate: r.endDate,
    current: r.isCurrent,
  }));
}

// Records the outcome of one consistency check, as counts by field and by source, so the feed and
// the Today view can show it. The mismatched values themselves are never stored in the event.
export async function recordFactsCheck(
  db: Db,
  input: {
    candidateId: CandidateId;
    claims: number;
    mismatches: { source: string; field: string }[];
  },
): Promise<void> {
  const count = (key: "source" | "field") => {
    const out: Record<string, number> = {};
    for (const m of input.mismatches) out[m[key]] = (out[m[key]] ?? 0) + 1;
    return out;
  };
  await db.insert(domainEvent).values({
    id: randomUUID(),
    candidateId: input.candidateId,
    aggregate: `candidate:${input.candidateId}`,
    type: "profile.facts_checked",
    actor: "user",
    reason:
      input.mismatches.length === 0
        ? "Employment facts agree with the official record"
        : "Employment facts disagree with the official record",
    inputsSummary: "",
    payload: {
      claims: input.claims,
      mismatches: input.mismatches.length,
      byField: count("field"),
      bySource: count("source"),
    },
    links: [],
    traceId: null,
    // Every check is its own event: running it again later is a new observation.
    idempotencyKey: `facts-check:${randomUUID()}`,
    occurredAt: new Date(),
  });
}
