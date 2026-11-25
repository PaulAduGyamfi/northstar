import { type CandidateId, feedLine } from "@northstar/domain";
import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import type { Db } from "./db.js";
import { inSpan } from "./resilience-event.js";
import { domainEvent } from "./schema.js";

// The activity feed (OBS-002): a candidate's events newest first, each as one plain sentence.
// Read-only. readFeedAfter serves the app's live feed (NS-153): what's new since the newest line
// shown.

export type FeedItem = {
  // Position in the log: pass the last one shown as `before` to read the next page.
  position: bigint;
  occurredAt: Date;
  type: string;
  actor: string;
  line: string;
};

export const MAX_FEED_PAGE = 200;

// The columns a feed line is made from.
const columns = {
  position: domainEvent.position,
  occurredAt: domainEvent.occurredAt,
  type: domainEvent.type,
  actor: domainEvent.actor,
  reason: domainEvent.reason,
  payload: domainEvent.payload,
};
type Row = { [K in keyof typeof columns]: (typeof columns)[K]["_"]["data"] };

// One event as a feed item. The text comes only from feedLine (db.md).
const toItem = (r: Row): FeedItem => ({
  position: r.position,
  occurredAt: r.occurredAt,
  type: r.type,
  actor: r.actor,
  line: feedLine({ type: r.type, actor: r.actor, reason: r.reason, payload: r.payload }),
});

function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FEED_PAGE) {
    throw new RangeError(`feed page size must be 1 to ${MAX_FEED_PAGE}`);
  }
}

export async function readFeed(
  db: Db,
  candidateId: CandidateId,
  page: { before?: bigint; limit: number },
): Promise<FeedItem[]> {
  checkLimit(page.limit);
  return inSpan("feed.read", { "northstar.feed.limit": page.limit }, async (span) => {
    const rows = await db
      .select(columns)
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
    return rows.map(toItem);
  });
}

// The lines after a position, oldest first: what a live feed adds on top of what it shows.
export async function readFeedAfter(
  db: Db,
  candidateId: CandidateId,
  page: { after: bigint; limit: number },
): Promise<FeedItem[]> {
  checkLimit(page.limit);
  return inSpan("feed.read_after", { "northstar.feed.limit": page.limit }, async (span) => {
    const rows = await db
      .select(columns)
      .from(domainEvent)
      .where(and(eq(domainEvent.candidateId, candidateId), gt(domainEvent.position, page.after)))
      .orderBy(asc(domainEvent.position))
      .limit(page.limit);
    span.setAttribute("northstar.feed.items", rows.length);
    return rows.map(toItem);
  });
}
