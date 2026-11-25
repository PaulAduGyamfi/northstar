import { type CandidateId, feedLine } from "@northstar/domain";
import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "./db.js";
import { inSpan } from "./resilience-event.js";
import { domainEvent } from "./schema.js";

// The activity feed (OBS-002): a candidate's events newest first, each as one plain sentence.
// Read-only. Live push (SSE/WebSocket) arrives with the API; it can follow readEventsAfter.

export type FeedItem = {
  // Position in the log: pass the last one shown as `before` to read the next page.
  position: bigint;
  occurredAt: Date;
  type: string;
  actor: string;
  line: string;
};

export const MAX_FEED_PAGE = 200;

export async function readFeed(
  db: Db,
  candidateId: CandidateId,
  page: { before?: bigint; limit: number },
): Promise<FeedItem[]> {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > MAX_FEED_PAGE) {
    throw new RangeError(`feed page size must be 1 to ${MAX_FEED_PAGE}`);
  }
  return inSpan("feed.read", { "northstar.feed.limit": page.limit }, async (span) => {
    const rows = await db
      .select({
        position: domainEvent.position,
        occurredAt: domainEvent.occurredAt,
        type: domainEvent.type,
        actor: domainEvent.actor,
        reason: domainEvent.reason,
        payload: domainEvent.payload,
      })
      .from(domainEvent)
      .where(
        and(
          eq(domainEvent.candidateId, candidateId),
          page.before === undefined ? undefined : lt(domainEvent.position, page.before),
        ),
      )
      .orderBy(desc(domainEvent.position))
      .limit(page.limit);
    span.setAttribute("northstar.feed.items", rows.length);
    return rows.map((r) => ({
      position: r.position,
      occurredAt: r.occurredAt,
      type: r.type,
      actor: r.actor,
      line: feedLine({
        type: r.type,
        actor: r.actor,
        reason: r.reason,
        payload: r.payload,
      }),
    }));
  });
}
