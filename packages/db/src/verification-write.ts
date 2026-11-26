import type { CandidateId } from "@northstar/domain";
import { and, asc, eq, type SQL, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import {
  verificationUsedMessage,
  verificationWindow,
  verificationWindowClose,
  verificationWindowRestart,
  type WINDOW_CLOSE_REASONS,
  type WINDOW_PURPOSES,
} from "./verification-schema.js";

// The one writer of the verification tables (NS-151, VER-001…006). The process reading mail and
// the gateway waiting for a code share windows through these functions; every race between them
// is settled by a unique constraint (one claim per message, one restart and one close per
// window), never by a read followed by a write. Names, domains, times and Gmail ids only.

export type WindowPurpose = (typeof WINDOW_PURPOSES)[number];
export type WindowCloseReason = (typeof WINDOW_CLOSE_REASONS)[number];

// A window as the catcher sees it: with the resend's times when it was restarted.
export type StoredWindowRow = {
  window: {
    id: string;
    tenant: string;
    ats: string;
    purpose: WindowPurpose;
    senderDomains: readonly string[];
    linkHosts: readonly string[];
    openedAt: Date;
    expiresAt: Date;
  };
  ttlMs: number;
  resent: boolean;
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// One candidate's window rows matching `where`, with their restart, if any, and whether closed.
function selectWindows(tx: Db | Tx, candidateId: CandidateId, where?: SQL) {
  return tx
    .select({
      id: verificationWindow.id,
      tenant: verificationWindow.tenant,
      ats: verificationWindow.ats,
      purpose: verificationWindow.purpose,
      senderDomains: verificationWindow.senderDomains,
      linkHosts: verificationWindow.linkHosts,
      ttlMs: verificationWindow.ttlMs,
      openedAt: verificationWindow.openedAt,
      expiresAt: verificationWindow.expiresAt,
      restartOpenedAt: verificationWindowRestart.openedAt,
      restartExpiresAt: verificationWindowRestart.expiresAt,
      closed: sql<boolean>`exists (select 1 from ${verificationWindowClose} c where c.window_id = ${verificationWindow.id})`,
    })
    .from(verificationWindow)
    .leftJoin(
      verificationWindowRestart,
      eq(verificationWindowRestart.windowId, verificationWindow.id),
    )
    .where(and(eq(verificationWindow.candidateId, candidateId), where));
}

// Locks one window row, so a restart and a close of the same window run one after the other.
async function lockWindow(tx: Tx, candidateId: CandidateId, windowId: string): Promise<boolean> {
  const [locked] = await tx
    .select({ id: verificationWindow.id })
    .from(verificationWindow)
    .where(
      and(eq(verificationWindow.candidateId, candidateId), eq(verificationWindow.id, windowId)),
    )
    .for("update");
  return locked !== undefined;
}

type WindowSelect = Awaited<ReturnType<typeof selectWindows>>[number];

function toStored(row: WindowSelect): StoredWindowRow {
  const resent = row.restartOpenedAt !== null;
  return {
    window: {
      id: row.id,
      tenant: row.tenant,
      ats: row.ats,
      purpose: row.purpose as WindowPurpose,
      senderDomains: row.senderDomains,
      linkHosts: row.linkHosts,
      openedAt: row.restartOpenedAt ?? row.openedAt,
      expiresAt: row.restartExpiresAt ?? row.expiresAt,
    },
    ttlMs: row.ttlMs,
    resent,
  };
}

// Payload for every window event: ids and the labels the feed shows, never a code or link.
const eventPayload = (w: StoredWindowRow["window"], outcome: string) => ({
  windowId: w.id,
  tenant: w.tenant,
  ats: w.ats,
  purpose: w.purpose,
  outcome,
});

export async function openVerificationWindow(
  db: Db,
  candidateId: CandidateId,
  window: StoredWindowRow["window"],
  ttlMs: number,
): Promise<void> {
  await inSpan("verification.window_open", { "verification.window_id": window.id }, () =>
    db.insert(verificationWindow).values({
      id: window.id,
      candidateId,
      tenant: window.tenant,
      ats: window.ats,
      purpose: window.purpose,
      senderDomains: [...window.senderDomains],
      linkHosts: [...window.linkHosts],
      ttlMs,
      openedAt: window.openedAt,
      expiresAt: window.expiresAt,
    }),
  );
}

// Every window not closed yet, oldest first. Expired ones are included: only timeout closes them.
export async function readOpenWindows(
  db: Db,
  candidateId: CandidateId,
): Promise<StoredWindowRow[]> {
  const rows = await selectWindows(
    db,
    candidateId,
    sql`not exists (select 1 from ${verificationWindowClose} c where c.window_id = ${verificationWindow.id})`,
  ).orderBy(asc(verificationWindow.openedAt), asc(verificationWindow.id));
  return rows.map(toStored);
}

// One window and whether it is closed, or null when this candidate has no such window.
export async function readVerificationWindow(
  db: Db,
  candidateId: CandidateId,
  windowId: string,
): Promise<(StoredWindowRow & { closed: boolean }) | null> {
  const [row] = await selectWindows(db, candidateId, eq(verificationWindow.id, windowId));
  return row ? { ...toStored(row), closed: row.closed } : null;
}

// Whether a Gmail message was already given to a window.
export async function isMessageUsed(
  db: Db,
  candidateId: CandidateId,
  gmailMessageId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: verificationUsedMessage.id })
    .from(verificationUsedMessage)
    .where(
      and(
        eq(verificationUsedMessage.candidateId, candidateId),
        eq(verificationUsedMessage.gmailMessageId, gmailMessageId),
      ),
    );
  return row !== undefined;
}

// Gives a message to a window. False when any window already had it (in this or another
// process): one email verifies at most one step.
export async function claimVerificationMessage(
  db: Db,
  candidateId: CandidateId,
  input: { gmailMessageId: string; windowId: string; receivedAt: Date },
): Promise<boolean> {
  const rows = await db
    .insert(verificationUsedMessage)
    .values({ candidateId, ...input })
    .onConflictDoNothing({
      target: [verificationUsedMessage.candidateId, verificationUsedMessage.gmailMessageId],
    })
    .returning({ id: verificationUsedMessage.id });
  return rows.length === 1;
}

// The one resend (VER-006): the window starts again. False when it was already restarted or is
// closed; the caller reads the window again.
export async function restartVerificationWindow(
  db: Db,
  candidateId: CandidateId,
  input: { windowId: string; openedAt: Date; expiresAt: Date },
): Promise<boolean> {
  return inSpan(
    "verification.window_restart",
    { "verification.window_id": input.windowId },
    (span) =>
      db.transaction(async (tx) => {
        if (!(await lockWindow(tx, candidateId, input.windowId))) return false;
        const [row] = await selectWindows(
          tx,
          candidateId,
          eq(verificationWindow.id, input.windowId),
        );
        if (!row || row.closed) return false;
        const inserted = await tx
          .insert(verificationWindowRestart)
          .values({ candidateId, ...input })
          .onConflictDoNothing({ target: verificationWindowRestart.windowId })
          .returning({ id: verificationWindowRestart.id });
        if (inserted.length === 0) return false;
        const w = toStored(row).window;
        await appendEvent(tx, span, {
          candidateId,
          aggregate: `verification_window:${w.id}`,
          type: "verification.resend",
          actor: "system",
          reason: "No verification email arrived, so the code was sent again",
          payload: eventPayload(w, "resend"),
          idempotencyKey: `verification_window:${w.id}:resend`,
          at: input.openedAt,
        });
        return true;
      }),
  );
}

// Ends a window once, with its event. False when it was already closed, or when its resend state
// differs from `seenResent` (it was restarted after the caller read it, which voids the codes the
// caller found): the caller hands nothing out.
export async function closeVerificationWindow(
  db: Db,
  candidateId: CandidateId,
  input: { windowId: string; reason: WindowCloseReason; at: Date; seenResent: boolean },
): Promise<boolean> {
  return inSpan(
    "verification.window_close",
    { "verification.window_id": input.windowId, "verification.outcome": input.reason },
    (span) =>
      db.transaction(async (tx) => {
        // A restart racing this close waits for it, and the other way round.
        if (!(await lockWindow(tx, candidateId, input.windowId))) return false;
        const [row] = await selectWindows(
          tx,
          candidateId,
          eq(verificationWindow.id, input.windowId),
        );
        if (!row || row.closed) return false;
        const stored = toStored(row);
        if (stored.resent !== input.seenResent) return false;
        const inserted = await tx
          .insert(verificationWindowClose)
          .values({
            candidateId,
            windowId: input.windowId,
            reason: input.reason,
            closedAt: input.at,
          })
          .onConflictDoNothing({ target: verificationWindowClose.windowId })
          .returning({ id: verificationWindowClose.id });
        if (inserted.length === 0) return false;
        const verified = input.reason === "verified";
        await appendEvent(tx, span, {
          candidateId,
          aggregate: `verification_window:${stored.window.id}`,
          type: verified ? "verification.verified" : "verification.needs_human",
          actor: "system",
          reason: verified
            ? "An email check was completed"
            : "An email check couldn't be completed and needs your hands",
          payload: eventPayload(stored.window, input.reason),
          idempotencyKey: `verification_window:${stored.window.id}:closed`,
          at: input.at,
        });
        return true;
      }),
  );
}

// The store the catcher in @northstar/inbox runs on (createStoredCatcher). Structural: this
// package doesn't import the inbox, and the inbox doesn't import the database.
export function dbWindowStore(db: Db, candidateId: CandidateId) {
  return {
    insert: (window: StoredWindowRow["window"], ttlMs: number) =>
      openVerificationWindow(db, candidateId, window, ttlMs),
    openWindows: () => readOpenWindows(db, candidateId),
    read: (windowId: string) => readVerificationWindow(db, candidateId, windowId),
    isUsed: (gmailMessageId: string) => isMessageUsed(db, candidateId, gmailMessageId),
    claim: (gmailMessageId: string, windowId: string, receivedAt: Date) =>
      claimVerificationMessage(db, candidateId, { gmailMessageId, windowId, receivedAt }),
    restart: (windowId: string, openedAt: Date, expiresAt: Date) =>
      restartVerificationWindow(db, candidateId, { windowId, openedAt, expiresAt }),
    close: (windowId: string, reason: WindowCloseReason, at: Date, seenResent: boolean) =>
      closeVerificationWindow(db, candidateId, { windowId, reason, at, seenResent }),
  };
}
