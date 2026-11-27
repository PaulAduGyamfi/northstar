import type { CandidateId } from "@northstar/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import {
  type DEAD_LETTER_ACTIONS,
  DEAD_LETTER_ID_KEY_PATTERN,
  DEAD_LETTER_SUBJECT_PATTERN,
  deadLetter,
  deadLetterResolution,
  NAME_PATTERN,
  REASON_CODE_PATTERN,
} from "./resilience-schema.js";

// The dead-letter store (NS-175, RES-007): work that exhausted its retries is recorded here and
// stays visible until Paul retries, skips or hands it off. Never silently dropped. The only
// writer of dead_letter and dead_letter_resolution. Kind, subject, codes and counts only.

// Every producer's kind (NS-236). A kind goes into the feed line, the event and the span, so it is
// a constant from this list, never built from data. A new producer adds its kind here in its own
// ticket, with its words in apps/web/src/dead-letters.ts.
export const DEAD_LETTER_KINDS = [
  "apply.stale_sweep", // NS-220: the stale-claim sweep (apps/worker sweep.ts)
  "apply.submission", // NS-226: a submission that ended without a visible outcome (ending.ts)
  // NS-240: a detected interview the store refused (too many changes, the daily limit;
  // runInterviewDetection in @northstar/inbox).
  "calendar.interview_detection",
  // NS-213 slice 2: a pass of the package decision relay (apps/worker relay.ts).
  "apply.signal_relay",
  // NS-241 slice 4: an approved prep plan the Calendar writer couldn't write after its tries.
  "calendar.prep_write",
] as const;
export type DeadLetterKind = (typeof DEAD_LETTER_KINDS)[number];

const KINDS: ReadonlySet<string> = new Set(DEAD_LETTER_KINDS);
const KIND = new RegExp(NAME_PATTERN);
const SUBJECT = new RegExp(DEAD_LETTER_SUBJECT_PATTERN);
const REASON = new RegExp(REASON_CODE_PATTERN);
const ID_KEY = new RegExp(DEAD_LETTER_ID_KEY_PATTERN);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type DeadLetterAction = (typeof DEAD_LETTER_ACTIONS)[number];

export type DeadLetterInput = {
  candidateId: CandidateId;
  kind: string;
  subject: string;
  reasonCode: string;
  attempts: number;
  // The producer's key for this failure: the same failure recorded twice is one letter.
  idempotencyKey: string;
};

export type DeadLetterView = {
  deadLetterId: string;
  kind: string;
  subject: string;
  reasonCode: string;
  attempts: number;
  deadAt: Date;
};

export type InvalidDeadLetter = { kind: "InvalidDeadLetter"; field: string };

// Which field of an input is malformed, or null when it is fine. The database checks the same.
function invalidField(input: DeadLetterInput): string | null {
  if (!KINDS.has(input.kind) || !KIND.test(input.kind) || input.kind.length > 64) return "kind";
  if (!SUBJECT.test(input.subject)) return "subject";
  if (!REASON.test(input.reasonCode)) return "reasonCode";
  if (!Number.isSafeInteger(input.attempts) || input.attempts < 1) return "attempts";
  if (!ID_KEY.test(input.idempotencyKey)) return "idempotencyKey";
  return null;
}

// Records work that gave up. The same key twice stores nothing the second time ("exists").
export async function recordDeadLetter(
  db: Db,
  input: DeadLetterInput,
): Promise<
  | { ok: true; value: { status: "recorded" | "exists"; deadLetterId: string } }
  | { ok: false; error: InvalidDeadLetter }
> {
  const field = invalidField(input);
  if (field) return { ok: false, error: { kind: "InvalidDeadLetter", field } };
  return inSpan("dead_letter.record", { "northstar.dead_letter.kind": input.kind }, (span) =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .insert(deadLetter)
        .values({
          candidateId: input.candidateId,
          kind: input.kind,
          subject: input.subject,
          reasonCode: input.reasonCode,
          attempts: input.attempts,
          idempotencyKey: input.idempotencyKey,
        })
        .onConflictDoNothing({ target: [deadLetter.candidateId, deadLetter.idempotencyKey] })
        .returning({ id: deadLetter.id, deadAt: deadLetter.deadAt });
      if (!row) {
        const [existing] = await tx
          .select({ id: deadLetter.id })
          .from(deadLetter)
          .where(
            and(
              eq(deadLetter.candidateId, input.candidateId),
              eq(deadLetter.idempotencyKey, input.idempotencyKey),
            ),
          );
        // The conflicting row was committed, so a fresh statement sees it; anything else is a bug.
        if (!existing) throw new Error("dead_letter conflict without a row");
        span.setAttribute("northstar.dead_letter.outcome", "exists");
        return { ok: true, value: { status: "exists", deadLetterId: existing.id } } as const;
      }
      await appendEvent(tx, span, {
        candidateId: input.candidateId,
        aggregate: `dead_letter:${row.id}`,
        type: "dead_letter.recorded",
        actor: "system",
        // The kind is from DEAD_LETTER_KINDS and the reason code is pattern-checked: safe to show.
        reason: `${input.kind} stopped after ${input.attempts} attempt${input.attempts === 1 ? "" : "s"} (${input.reasonCode}); it waits for you to retry, skip or hand it off`,
        // Ids, kind, codes and counts only: never a payload, message or URL.
        payload: {
          deadLetterId: row.id,
          kind: input.kind,
          reasonCode: input.reasonCode,
          attempts: input.attempts,
        },
        idempotencyKey: `dead_letter:${row.id}`,
        at: row.deadAt,
      });
      span.setAttribute("northstar.dead_letter.outcome", "recorded");
      return { ok: true, value: { status: "recorded", deadLetterId: row.id } } as const;
    }),
  );
}

// Letters nobody has resolved yet, oldest first; pass a kind to see only that kind.
export async function listOpenDeadLetters(
  db: Db,
  candidateId: CandidateId,
  kind?: string,
): Promise<DeadLetterView[]> {
  return db
    .select({
      deadLetterId: deadLetter.id,
      kind: deadLetter.kind,
      subject: deadLetter.subject,
      reasonCode: deadLetter.reasonCode,
      attempts: deadLetter.attempts,
      deadAt: deadLetter.deadAt,
    })
    .from(deadLetter)
    .where(
      and(
        eq(deadLetter.candidateId, candidateId),
        kind === undefined ? undefined : eq(deadLetter.kind, kind),
        sql`not exists (
          select 1 from ${deadLetterResolution} r where r.dead_letter_id = ${deadLetter.id}
        )`,
      ),
    )
    .orderBy(asc(deadLetter.deadAt), asc(deadLetter.id));
}

const ACTION_REASON: Record<DeadLetterAction, string> = {
  retry: "Sent back to be tried again",
  skip: "Skipped; it won't be tried again",
  hand_off: "Handed off to do by hand",
};

// Paul (or the system) resolves a letter once: retry, skip or hand off. Returns the letter's kind
// and subject, so the caller can run it again or open the hand-off.
export async function resolveDeadLetter(
  db: Db,
  input: {
    candidateId: CandidateId;
    deadLetterId: string;
    action: DeadLetterAction;
    actor: "user" | "system";
  },
): Promise<
  | { ok: true; value: { kind: string; subject: string } }
  | { ok: false; error: { kind: "NotFound" } | { kind: "AlreadyResolved" } }
> {
  if (!UUID.test(input.deadLetterId)) return { ok: false, error: { kind: "NotFound" } };
  return inSpan(
    "dead_letter.resolve",
    { "northstar.dead_letter.action": input.action },
    async (span) => {
      // A second resolution racing this one waits on the unique key, then does nothing (ON
      // CONFLICT below) and gets AlreadyResolved: no error to catch.
      return db.transaction(async (tx) => {
        const [letter] = await tx
          .select({ kind: deadLetter.kind, subject: deadLetter.subject })
          .from(deadLetter)
          .where(
            and(
              eq(deadLetter.id, input.deadLetterId),
              eq(deadLetter.candidateId, input.candidateId),
            ),
          );
        if (!letter) return { ok: false, error: { kind: "NotFound" } } as const;
        const [row] = await tx
          .insert(deadLetterResolution)
          .values({
            candidateId: input.candidateId,
            deadLetterId: input.deadLetterId,
            action: input.action,
            actor: input.actor,
          })
          .onConflictDoNothing({ target: deadLetterResolution.deadLetterId })
          .returning({
            id: deadLetterResolution.id,
            resolvedAt: deadLetterResolution.resolvedAt,
          });
        if (!row) return { ok: false, error: { kind: "AlreadyResolved" } } as const;
        await appendEvent(tx, span, {
          candidateId: input.candidateId,
          aggregate: `dead_letter:${input.deadLetterId}`,
          type: "dead_letter.resolved",
          actor: input.actor,
          reason: ACTION_REASON[input.action],
          payload: {
            deadLetterId: input.deadLetterId,
            resolutionId: row.id,
            action: input.action,
            kind: letter.kind,
          },
          idempotencyKey: `dead_letter_resolution:${row.id}`,
          at: row.resolvedAt,
        });
        return { ok: true, value: letter } as const;
      });
    },
  );
}
