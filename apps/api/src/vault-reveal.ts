import type { Db } from "@northstar/db";
import type { CandidateId } from "@northstar/domain";
import { dbRevealPorts, type MasterKey, revealTenantPassword } from "@northstar/gateways";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";
import { AuthenticationJson, type PasskeyAssertion } from "./passkeys.js";
import type { Sessions } from "./sessions.js";

// Revealing one of Paul's vault passwords to him (NS-230, CRD-002, ADR-0024). The only API file
// that may name the reveal path: the vault's boundary test fails if any other does. A reveal makes
// its own one-time approval, so this route is the whole check. It needs:
// - Paul's session;
// - a passkey assertion for the `reveal` ceremony, made within a minute and used once;
// - the `vault` kill switch on;
// - and no more than REVEALS_PER_MINUTE reveals.
// Only then is the master key loaded, for this request only. The password goes in the response
// and nowhere else: spans carry an outcome code only.

export const REVEALS_PER_MINUTE = 5;
const MINUTE_MS = 60_000;

export type VaultRevealDeps = {
  db: Db;
  candidateId: () => Promise<CandidateId>;
  sessions: Sessions;
  assertion: PasskeyAssertion;
  // Whether the `vault` kill switch is on (no row means on).
  isVaultOn: () => Promise<boolean>;
  // Loads the master key from VAULT_MASTER_KEY_FILE (loadVaultKey); called only to reveal.
  loadKey: () => Promise<MasterKey>;
  now: () => number;
};

// The tenant key as the vault stores it (`<ats>:<tenant>`); the database checks it again.
const TenantKey = z.string().trim().min(3).max(200);
const Options = z.object({ options: z.record(z.string(), z.unknown()) });
const Revealed = z.object({ password: z.string() });

export function vaultRevealEndpoints(deps: VaultRevealDeps): AnyEndpoint[] {
  // When each recent reveal was let through, oldest first.
  const recent: number[] = [];
  const overLimit = (): boolean => {
    const since = deps.now() - MINUTE_MS;
    while (recent.length > 0 && (recent[0] ?? 0) <= since) recent.shift();
    return recent.length >= REVEALS_PER_MINUTE;
  };

  const options = endpoint({
    method: "POST",
    path: "/vault/reveal/options",
    auth: "session",
    input: z.object({}),
    output: Options,
    handler: async () => {
      if (deps.sessions.throttled()) return { ok: false, status: 429, error: "throttled" };
      return { ok: true, body: { options: await deps.assertion.options() } };
    },
  });

  const reveal = endpoint({
    method: "POST",
    path: "/vault/reveal",
    auth: "session",
    input: z.object({ tenantKey: TenantKey, response: AuthenticationJson }),
    output: Revealed,
    handler: async ({ tenantKey, response }, { span }) => {
      const outcome = (code: string) => span.setAttribute("northstar.vault.reveal", code);
      // Checked first, as for sign-in: a burst of failures can't be followed by a success.
      if (deps.sessions.throttled() || overLimit()) {
        outcome("throttled");
        return { ok: false, status: 429, error: "throttled" };
      }
      // The slot is taken before the await, so concurrent requests can't all pass the limit; a
      // refused assertion gives it back (its failure counts toward the throttle instead). A reveal
      // refused later (locked vault, unknown tenant) keeps its slot on purpose: it was Paul's.
      const slot = deps.now();
      recent.push(slot);
      const refused = await deps.assertion.verify(response);
      if (refused !== null) {
        recent.splice(recent.indexOf(slot), 1);
        deps.sessions.recordFailure();
        outcome(refused);
        return { ok: false, status: 401, error: "passkey_refused" };
      }
      // A locked vault never loads the key.
      if (!(await deps.isVaultOn())) {
        outcome("vault_locked");
        return { ok: false, status: 503, error: "vault_locked" };
      }
      let key: MasterKey;
      try {
        key = await deps.loadKey();
      } catch {
        // No detail: the file's path or contents never reach a response or span.
        outcome("key_unavailable");
        return { ok: false, status: 503, error: "vault_locked" };
      }
      const result = await revealTenantPassword(dbRevealPorts(deps.db), key, {
        candidateId: await deps.candidateId(),
        tenantKey,
      });
      if (!result.ok) {
        outcome(result.error.kind);
        if (result.error.kind === "SecretNotFound") {
          return { ok: false, status: 404, error: "not_found" };
        }
        if (result.error.kind === "InvalidVaultInput") {
          return { ok: false, status: 400, error: "invalid_tenant" };
        }
        // VaultLocked (the switch flipped meanwhile), a wrong key or tampered rows.
        return { ok: false, status: 503, error: "vault_locked" };
      }
      outcome("revealed");
      return { ok: true, body: { password: result.value.reveal() } };
    },
  });

  return [options, reveal];
}
