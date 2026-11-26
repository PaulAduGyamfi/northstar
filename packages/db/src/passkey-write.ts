import { type CandidateId, err, ok, type Result } from "@northstar/domain";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { passkeyCredential, passkeyUse } from "./passkey-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";

// Paul's passkeys (NS-178, ADR-0022): the only writer of passkey_credential and passkey_use.
// Credential ids and public keys verify a sign-in and go nowhere else: events and spans carry the
// row id and outcomes only.

const UNIQUE_VIOLATION = "23505";

export type PasskeyInput = {
  candidateId: CandidateId;
  credentialId: string;
  publicKey: Uint8Array;
  signCount: number;
  transports: string[];
};

export type StoredPasskey = {
  passkeyId: string;
  credentialId: string;
  publicKey: Uint8Array;
  // The newest sign count: the latest use's, or the one at registration.
  signCount: number;
  transports: string[];
};

export type AlreadyRegistered = { kind: "AlreadyRegistered" };
export type SignCountNotIncreased = { kind: "SignCountNotIncreased" };
export type PasskeyNotFound = { kind: "NotFound" };

// The Postgres error code of a failed query, through drizzle's wrapper.
const codeOf = (error: unknown): unknown =>
  (error as { code?: unknown }).code ?? (error as { cause?: { code?: unknown } }).cause?.code;

// Registers a passkey after its registration ceremony was verified (apps/api). A credential id
// seen before is refused, not merged: one authenticator key, one row.
export async function savePasskey(
  db: Db,
  input: PasskeyInput,
): Promise<Result<{ passkeyId: string }, AlreadyRegistered>> {
  return inSpan("db.passkey.save", {}, async (span) => {
    try {
      const passkeyId = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(passkeyCredential)
          .values({
            candidateId: input.candidateId,
            credentialId: input.credentialId,
            publicKey: input.publicKey,
            signCount: input.signCount,
            transports: input.transports,
          })
          .returning({ id: passkeyCredential.id, createdAt: passkeyCredential.createdAt });
        if (!row) throw new Error("passkey_credential insert returned no row");
        await appendEvent(tx, span, {
          candidateId: input.candidateId,
          aggregate: `passkey:${row.id}`,
          type: "passkey.registered",
          actor: "user",
          reason: "A passkey was added",
          payload: { passkeyId: row.id },
          idempotencyKey: `passkey_credential:${row.id}`,
          at: row.createdAt,
        });
        return row.id;
      });
      span.setAttribute("northstar.passkey.outcome", "saved");
      return ok({ passkeyId });
    } catch (error) {
      if (codeOf(error) !== UNIQUE_VIOLATION) throw error;
      span.setAttribute("northstar.passkey.outcome", "already_registered");
      return err({ kind: "AlreadyRegistered" });
    }
  });
}

// The candidate's passkeys, for the browser's allow and exclude lists. Oldest first.
export async function listPasskeys(
  db: Db,
  candidateId: CandidateId,
): Promise<{ credentialId: string; transports: string[] }[]> {
  return db
    .select({
      credentialId: passkeyCredential.credentialId,
      transports: passkeyCredential.transports,
    })
    .from(passkeyCredential)
    .where(eq(passkeyCredential.candidateId, candidateId))
    .orderBy(passkeyCredential.createdAt);
}

// One of the candidate's passkeys by credential id, with its newest sign count, or null.
export async function readPasskey(
  db: Db,
  candidateId: CandidateId,
  credentialId: string,
): Promise<StoredPasskey | null> {
  const [row] = await db
    .select({
      passkeyId: passkeyCredential.id,
      credentialId: passkeyCredential.credentialId,
      publicKey: passkeyCredential.publicKey,
      transports: passkeyCredential.transports,
      // Counts only move forward (recordPasskeyUse), so the largest is the newest.
      // Written out with table names: drizzle leaves single-table columns unqualified, which inside
      // the subquery would mean passkey_use's own columns.
      signCount: sql<string>`greatest("passkey_credential"."sign_count", coalesce((select max("passkey_use"."sign_count") from "passkey_use" where "passkey_use"."passkey_id" = "passkey_credential"."id"), 0))`,
    })
    .from(passkeyCredential)
    .where(
      and(
        eq(passkeyCredential.candidateId, candidateId),
        eq(passkeyCredential.credentialId, credentialId),
      ),
    );
  if (!row) return null;
  return {
    passkeyId: row.passkeyId,
    credentialId: row.credentialId,
    publicKey: new Uint8Array(row.publicKey),
    signCount: Number(row.signCount),
    transports: row.transports,
  };
}

// Records a verified sign-in. The count must increase, or stay at 0 for an authenticator that
// never counts (platform passkeys): anything else may be a cloned key, so it's refused. Two
// sign-ins racing with the same count: the unique index lets one in.
export async function recordPasskeyUse(
  db: Db,
  candidateId: CandidateId,
  passkeyId: string,
  signCount: number,
): Promise<Result<void, SignCountNotIncreased | PasskeyNotFound>> {
  return inSpan("db.passkey.use", {}, async (span) => {
    const outcome = await db.transaction(
      async (tx): Promise<Result<void, SignCountNotIncreased | PasskeyNotFound>> => {
        // Locks the credential row (FOR UPDATE fires no update trigger), so racing uses queue.
        const [row] = await tx
          .select({ signCount: passkeyCredential.signCount })
          .from(passkeyCredential)
          .where(
            and(
              eq(passkeyCredential.id, passkeyId),
              eq(passkeyCredential.candidateId, candidateId),
            ),
          )
          .for("update");
        if (!row) return err({ kind: "NotFound" });
        const [last] = await tx
          .select({ max: sql<string | null>`max(${passkeyUse.signCount})` })
          .from(passkeyUse)
          .where(eq(passkeyUse.passkeyId, passkeyId));
        const current = Math.max(row.signCount, Number(last?.max ?? 0));
        const forward = signCount > current || (signCount === 0 && current === 0);
        if (!forward) return err({ kind: "SignCountNotIncreased" });
        await tx.insert(passkeyUse).values({ candidateId, passkeyId, signCount });
        return ok(undefined);
      },
    );
    span.setAttribute("northstar.passkey.outcome", outcome.ok ? "used" : outcome.error.kind);
    return outcome;
  });
}
