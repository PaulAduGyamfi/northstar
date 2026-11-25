# NS-122: Credential vault (password-manager mirror split out)

Status: accepted (autonomous lane, ADR-0016)
Requirements: CRD-001, CRD-002, CRD-003, CRD-005 (CRD-004 split out, see below)
Rules that apply: ADR-0010, ADR-0002, ADR-0007, ADR-0016, `.claude/rules/db.md`,
`.claude/rules/gateways.md`

## Why
Workday-style ATSs need one candidate account per employer tenant. ADR-0010 has Northstar
generate a strong password per tenant and keep it in a vault that only the Apply Gateway can open,
at the moment of use, with every opening audited. The tenant registry and Workday adapter
(NS-124, #23) are blocked on this ticket.

## Behavior
1. **Envelope encryption (CRD-001).** Each stored secret gets its own random 256-bit data key.
   The secret is encrypted with AES-256-GCM under the data key, and the data key is wrapped with
   AES-256-GCM under the master key. The master key is 32 random bytes in a key file outside the
   repo and the database, named by `VAULT_MASTER_KEY_FILE` and read by one typed config loader.
   Each row stores the master key's id (a SHA-256 fingerprint), so a wrong key is reported as
   `VaultKeyMismatch`, not garbage. The candidate and tenant are bound in as associated data, so
   a ciphertext copied onto another tenant or candidate won't open. (Not the version: sealing
   happens before the database numbers the version, and rows are append-only.) A database dump alone holds only
   wrapped keys and ciphertext.
2. **Storage.** `vault_secret` (packages/db) holds one row per tenant and version, append-only (a
   trigger refuses UPDATE, DELETE and TRUNCATE). Rotating a password stores a new version; the
   newest version is the current one. It is written only through `vault-write.ts`.
3. **Only the Apply Gateway decrypts (CRD-002).** Decryption lives in
   `packages/gateways/src/vault/`, is not exported from `@northstar/gateways`, and returns a
   `VaultSecret` that prints `[redacted]` in strings, JSON and `inspect`. The master key is opaque
   (a private field; only the vault's seal and open modules read its bytes), and sealed rows are
   not exported from `@northstar/db` (only the audit table is). A boundary test fails if any other
   file imports the decrypt module, calls `createDecipheriv`, reads the key's bytes or touches
   `vault_secret`, or if the package's public entry exports a decrypt function. Database errors
   come back as a plain "db.vault.store failed" / "db.vault.open failed" with no cause, since the
   driver's message lists the query's parameters (sealed bytes).
4. **Audit (CRD-003).** Opening a secret needs a Gate decision id (an `approvalId` or
   `policyDecisionId`), an actor and a purpose. In one transaction the database checks the vault
   isn't locked, checks the decision is a live approval of this candidate (approved, past its undo
   window by the Gate's clock, not undone; otherwise `NotApproved`), appends a `vault_access` row
   (who, tenant, purpose, decision, when; append-only) and returns the sealed row. Every open is
   audited, including one whose decryption then fails. The caller still runs `verifyApproval`
   for the action it serves, which also checks the decision covers that exact content.
   The open takes a shared lock against `setKillSwitch(vault)`, so a lock that commits first
   always wins.
5. **Lock vault (CRD-005).** A new kill-switch subsystem, `vault`. While it is off, every open is
   refused (`VaultLocked`) before anything is read or decrypted. Storing still works, so an
   account created just before the lock isn't lost.
6. **Password generation.** `generateTenantPassword()` returns 24 characters from a mixed
   alphabet using `crypto.randomInt`, with at least one lowercase letter, uppercase letter, digit
   and symbol, as ATS password rules require.

## Acceptance criteria
- [ ] Sealing then opening with the same master key returns the password; with another key it
      is `VaultKeyMismatch`; a tampered ciphertext or wrapped key, or a row moved to another
      tenant or candidate, fails to open.
- [ ] Two seals of the same password differ (fresh data key and IVs).
- [ ] `loadVaultKey` reads a 32-byte key file (base64) and refuses a missing setting, an
      unreadable file or a wrong length, naming the setting, never the path or key bytes.
- [ ] Storing writes version 1, then 2 on rotation; the open returns the newest.
- [ ] `vault_secret` and `vault_access` refuse UPDATE, DELETE and TRUNCATE.
- [ ] Opening writes one `vault_access` row with actor, purpose and decision id, and a
      `vault.opened` event with ids and the tenant key only.
- [ ] Opening under an unknown, rejected, undone or not-yet-effective decision is `NotApproved`
      and writes nothing.
- [ ] A failed store throws a message with no sealed bytes and no cause.
- [ ] With the `vault` kill switch off, opening is `VaultLocked`, writes no access row and
      decrypts nothing.
- [ ] No event, span attribute or error message contains the password, a key or the ciphertext.
- [ ] Boundary test: no file outside `packages/gateways/src/` imports `vault/open`, and
      `@northstar/gateways` doesn't export it.
- [ ] The feed says "Saved / Changed the password for workday:acme" and "Used the saved
      password for workday:acme to sign in".
- [ ] The generated password is 24 characters and has every character class.

## Failure modes
- Key file missing or wrong: the loader throws at startup naming `VAULT_MASTER_KEY_FILE`;
  nothing can open, which fails closed.
- Database down: storing and opening throw; nothing is half-written (one transaction each).
- Key lost: secrets can't be opened. The recovery is resetting tenant passwords by email (ADR-0010
  consequences); `.env.example` says to back the key file up.

## Observability
- Events: `vault_secret.stored` (tenant key, version) and `vault.opened` (tenant key, version,
  purpose, decision id), plus `kill_switch.set` for the lock. Spans `db.vault.store` and
  `db.vault.open` with the tenant key and outcome kind only.

## Out of scope (follow-up issues)
- **CRD-004, the password-manager mirror:** needs Paul's Q-16 choice (Bitwarden or 1Password), a
  CLI or service-account credential, and network beyond the package registry. Filed as
  `needs:paul`.
- **CRD-002's UI reveal after a fresh passkey check:** needs the web app and passkeys (NS-156 and
  its follow-up). Filed as an `agent-filed` follow-up.
- Cloud KMS for hosted use; the tenant registry and account creation (NS-124).

## Open questions
- Tenant key format: `<ats>:<tenant>` in lowercase (for example `workday:acme`), matching the
  ATS vocabulary. NS-124 may refine it.
