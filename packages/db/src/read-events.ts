import type { CandidateId } from "@northstar/domain";
import { and, asc, eq, gt } from "drizzle-orm";
import type { Db } from "./db.js";
import { rowToStoredEvent, type StoredEvent } from "./events.js";
import { domainEvent } from "./schema.js";

// Reads a candidate's events in log order after a cursor (ADR-0012). A reader stores the last
// position it handled and passes it back here; 0n starts from the beginning.
export async function readEventsAfter(
  db: Db,
  candidateId: CandidateId,
  position: bigint,
  limit: number,
): Promise<StoredEvent[]> {
  const rows = await db
    .select()
    .from(domainEvent)
    .where(and(eq(domainEvent.candidateId, candidateId), gt(domainEvent.position, position)))
    .orderBy(asc(domainEvent.position))
    .limit(limit);
  return rows.map(rowToStoredEvent);
}
