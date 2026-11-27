import type { CandidateId } from "@northstar/domain";
import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { mailPollCursor } from "./mail-poll-schema.js";
import { inSpan } from "./resilience-event.js";

// The mail poll's stored cursor (NS-247 slice 2, #293): the only writer and reader of
// mail_poll_cursor. It holds two values and no message id, address or subject.

export type MailCursor = { since: Date; overlap: boolean };

// How far ahead of this machine's clock a cursor may be: room for clock skew between Gmail's
// receive times and here, and no more.
export const CURSOR_SKEW_MS = 5 * 60 * 1000;

// A cursor after now (security review of NS-247 slice 2). Since it never moves backwards, a stored
// future cursor would stick: Gmail lists nothing after it, and job mail would silently stop being
// linked. So it is refused loudly, never stored.
export class FutureCursorError extends Error {
  constructor() {
    super("mail cursor is in the future");
    this.name = "FutureCursorError";
  }
}

// The newest cursor, or null before the first poll saved one.
export async function readMailCursor(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
): Promise<MailCursor | null> {
  const [row] = await db
    .select({ since: mailPollCursor.since, overlap: mailPollCursor.overlap })
    .from(mailPollCursor)
    .where(eq(mailPollCursor.candidateId, candidateId))
    .orderBy(desc(mailPollCursor.position))
    .limit(1);
  return row ? { since: row.since, overlap: row.overlap } : null;
}

// Stores the next cursor. Never moves `since` backwards: a run that started earlier and finished
// later can't rewind it, so mail after the newer cursor is never read twice in a loop (and the
// step records nothing twice anyway). An unchanged cursor stores nothing. No domain event: it moves
// on every tick with mail, and the feed would fill with bookkeeping; the span records the save.
export async function saveMailCursor(
  db: Db,
  input: { candidateId: CandidateId; since: Date; overlap: boolean },
  now: () => Date = () => new Date(),
): Promise<{ saved: boolean; cursor: MailCursor }> {
  if (input.since.getTime() > now().getTime() + CURSOR_SKEW_MS) throw new FutureCursorError();
  try {
    return await inSpan("mail.cursor_save", {}, (span) =>
      db.transaction(async (tx) => {
        // The candidate's row lock serializes saves, so two racing ticks can't both pass the
        // never-backwards check against the same old row.
        await tx.execute(sql`select id from candidate where id = ${input.candidateId} for update`);
        const current = await readMailCursor(tx, input.candidateId);
        const next: MailCursor =
          current !== null && input.since.getTime() < current.since.getTime()
            ? current
            : { since: input.since, overlap: input.overlap };
        const unchanged =
          current !== null &&
          current.since.getTime() === next.since.getTime() &&
          current.overlap === next.overlap;
        span.setAttribute("northstar.mail.cursor_saved", !unchanged);
        if (unchanged) return { saved: false, cursor: current };
        await tx.insert(mailPollCursor).values({
          candidateId: input.candidateId,
          since: next.since,
          overlap: next.overlap,
        });
        return { saved: true, cursor: next };
      }),
    );
  } catch {
    // A fresh error with no cause: the driver's message lists the query's parameters.
    throw new Error("mail.cursor_save failed");
  }
}
