# ADR-0010 — Credential vault and account automation for account-wall ATSs

**Status:** Accepted (product owner, 2026-11-24) · **Date:** 2026-11-24
**Supersedes:** the "no server-side passwords" clauses of APPLY-010 and NFR-SEC-003.

## Context
Workday and similar ATSs require a separate candidate account per employer tenant, plus email
verification. The product owner calls these the worst applications to fill out and wants them
effortless every time (requirements 15). The earlier design kept third-party passwords only in
the user's browser, which forces a human into every account-wall application and breaks the
"≤ 1 click" goal.

## Decision
1. Northstar generates a unique strong password per tenant and stores it in a **credential vault**
   with envelope encryption. The master key lives outside the database: a local key file in P1,
   cloud KMS when hosted. Never in the repo.
2. **Only the Apply Gateway** decrypts, at the moment of use, under an approval or policy decision.
   Every decrypt is audit-logged. Agents, the API, logs, traces, prompts and the UI never see
   plaintext. Package boundaries enforce this with a lint and test rule.
3. Every created or rotated password is **mirrored to the user's password manager** (Bitwarden or
   1Password, Q-16), so the user can always sign in by hand.
4. Email verification uses a session-bound **Verification Catcher** fed by Gmail push: sender
   allowlist, time window, single use, deterministic extraction first, and magic links opened
   only on allowlisted hosts. Codes and links are never logged or stored.
5. CAPTCHAs, SMS and phone checks are still never automated. They become a one-click handoff
   (ADR-0003 unchanged).
6. Account creation accepts standard candidate terms only under the user's consent policy, with
   a snapshot of each notice kept.

## Alternatives considered
- **Browser-only credentials (previous design):** safest, but every account-wall application
  needs a human. Rejected for effort.
- **Password manager only:** fewer copies, but automation depends on a third-party CLI or
  service account being up. Kept as the mirror, not the primary.
- **One shared password across tenants:** simpler, but one breached tenant exposes all. Rejected.

## Consequences
- + Account-wall applications become zero-click unless a challenge appears.
- − Northstar now holds credentials for many sites, which raises the security bar. The vault, the
  gateway and the catcher always require `security-reviewer` on changes (`.claude/rules/gateways.md`).
- − A vault-key loss means resetting passwords by email, so the key needs a documented backup.
