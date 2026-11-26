import type { CandidateId } from "@northstar/domain";
import { and, eq } from "drizzle-orm";
import type { Db } from "./db.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import { application, domainEvent } from "./schema.js";

// The visible item when an application package can't be finished by code (NS-227 slice 5,
// APPLY-006): one domain event on the application, whose `reason` is its feed line. Its type is
// `package.needs_human`, not `application.*`: feedLine reads every `application.*` type as a
// status move ("Application status changed"), and no status moves here. Ids, reason
// codes and counts only: never a field name, label, answer or contact detail.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// A reason code is a short snake_case word ("no_contact", "file_upload"): nothing else fits.
const CODE = /^[a-z][a-z_]{0,39}$/;
const MAX_CODES = 20;
const UNIQUE_VIOLATION = "23505";

// The SQLSTATE of a driver error (node-postgres puts it on the error, drizzle on its cause).
function sqlStateOf(error: unknown): string | undefined {
  const own = (error as { code?: unknown }).code;
  const cause = (error as { cause?: { code?: unknown } }).cause?.code;
  const code = typeof own === "string" ? own : cause;
  return typeof code === "string" ? code : undefined;
}

export type PackageNeedsHumanRefusal = { kind: "InvalidNeedsHuman" };

export async function recordPackageNeedsHuman(
  db: Db,
  input: {
    candidateId: CandidateId;
    applicationId: string;
    // How many items each reason stops; e.g. { no_bank_answer: 2, no_phone: 1 }.
    reasons: Record<string, number>;
    // SHA-256 of what the caller assembled from: the same inputs again record nothing.
    basis: string;
  },
): Promise<
  { ok: true; value: { recorded: boolean } } | { ok: false; error: PackageNeedsHumanRefusal }
> {
  const entries = Object.entries(input.reasons).sort(([a], [b]) => (a < b ? -1 : 1));
  const valid =
    UUID.test(input.applicationId) &&
    SHA256.test(input.basis) &&
    entries.length >= 1 &&
    entries.length <= MAX_CODES &&
    entries.every(([code, n]) => CODE.test(code) && Number.isInteger(n) && n >= 1 && n <= 1000);
  if (!valid) return { ok: false, error: { kind: "InvalidNeedsHuman" } };
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  const key = `application:${input.applicationId}:package_needs_human:${input.basis}`;
  return inSpan(
    "db.package.needs_human",
    { "northstar.application.id": input.applicationId, "northstar.package.items": total },
    (span) =>
      db.transaction(async (tx) => {
        // The candidate's own application only.
        const [owned] = await tx
          .select({ id: application.id })
          .from(application)
          .where(
            and(
              eq(application.id, input.applicationId),
              eq(application.candidateId, input.candidateId),
            ),
          );
        if (!owned) return { ok: false, error: { kind: "InvalidNeedsHuman" } } as const;
        const [seen] = await tx
          .select({ id: domainEvent.id })
          .from(domainEvent)
          .where(
            and(
              eq(domainEvent.candidateId, input.candidateId),
              eq(domainEvent.idempotencyKey, key),
            ),
          );
        if (seen) return { ok: true, value: { recorded: false } } as const;
        // A concurrent call with the same basis may insert first; the savepoint keeps this
        // transaction usable when its insert then loses on the idempotency key.
        try {
          await tx.transaction(async (inner) => {
            await appendEvent(inner, span, {
              candidateId: input.candidateId,
              aggregate: `application:${input.applicationId}`,
              type: "package.needs_human",
              actor: "system",
              // The feed line: fixed words and a number.
              reason: `The application package needs you: ${total} item${total === 1 ? "" : "s"}`,
              payload: {
                applicationId: input.applicationId,
                reasons: Object.fromEntries(entries),
                items: total,
              },
              idempotencyKey: key,
              at: new Date(),
            });
          });
        } catch (error) {
          if (sqlStateOf(error) === UNIQUE_VIOLATION)
            return { ok: true, value: { recorded: false } } as const;
          throw error;
        }
        return { ok: true, value: { recorded: true } } as const;
      }),
  );
}
