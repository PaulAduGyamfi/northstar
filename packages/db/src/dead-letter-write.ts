import type { CandidateId } from "@northstar/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import {
  type DEAD_LETTER_ACTIONS,
  DEAD_LETTER_SUBJECT_PATTERN,
  deadLetter,
  deadLetterResolution,
  NAME_PATTERN,
  REASON_CODE_PATTERN,
} from "./resilience-schema.js";

// The dead-letter store (NS-175, RES-007): work that exhausted its retries is recorded here and
// stays visible until Paul retries, skips or hands it off. Never silently dropped. The only
// writer of dead_letter and dead_letter_resolution. Kind, subject, codes and counts only.

const KIND = new RegExp(NAME_PATTERN);
const SUBJECT = new RegExp(DEAD_LETTER_SUBJECT_PATTERN);
const REASON = new RegExp(REASON_CODE_PATTERN);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNIQUE_VIOLATION = "23505";

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
  if (!KIND.test(input.kind) || input.kind.length > 64) return "kind";
  if (!SUBJECT.test(input.subject)) return "subject";
  if (!REASON.test(input.reasonCode)) return "reasonCode";
  if (!Number.isSafeInteger(input.attempts) || input.attempts < 1) return "attempts";
  if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 200) return "idempotencyKey";
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
        span.setAttribute("northstar.dead_letter.outcome", "exists");
        return { ok: true, value: { status: "exists", deadLetterId: existing?.id ?? "" } } as const;
      }
      await appendEvent(tx, span, {
        candidateId: input.candidateId,
        aggregate: `dead_letter:${row.id}`,
        type: "dead_letter.recorded",
        actor: "system",
        reason: `Work stopped after ${input.attempts} attempt${input.attempts === 1 ? "" : "s"}; it waits for you to retry, skip or hand it off`,
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
      try {
        return await db.transaction(async (tx) => {
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
      } catch (error) {
        // A concurrent resolution of the same letter committed first.
        const code =
          (error as { code?: unknown; cause?: { code?: unknown } }).code ??
          (error as { cause?: { code?: unknown } }).cause?.code;
        if (code === UNIQUE_VIOLATION)
          return { ok: false, error: { kind: "AlreadyResolved" } } as const;
        throw error;
      }
    },
  );
}
