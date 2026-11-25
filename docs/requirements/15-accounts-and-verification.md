# 15 — Account-Wall Applications & Email Verification

Product owner (2026-11-24): *"The worst type of applications are the ones that make you create an
account first, for example Workday. We need a way to make that process effortless for every
occurrence, as well as handling sites that send confirmation codes to email to verify it's me."*

## The problem
- **Workday** (and iCIMS, Taleo, SuccessFactors, some SmartRecruiters and Oracle tenants) require
  a candidate account **per employer tenant**: `acme.wd5.myworkdayjobs.com` and
  `globex.wd1.myworkdayjobs.com` are separate accounts, each with a password, an email
  verification step, and often a multi-page form that re-asks what's on the resume.
- Many sites send a **one-time code or magic link** by email to verify the candidate, at sign-up,
  sign-in, or submit.
- Done by hand, each is 10–20 minutes of friction. That's exactly the work Northstar exists to
  remove.

## Target experience
| Situation | Human effort |
|---|---|
| First application on a new tenant, no CAPTCHA | **0 clicks**: account created, email verified, form filled, package queued for normal approval |
| First application on a new tenant **with** a CAPTCHA or SMS check | **1 handoff** (~60 s): solve the challenge in your own browser; everything else is done |
| Any later application on a known tenant | **0 clicks**: signs in automatically |
| Forgotten or expired password | **0 clicks**: reset by email link, new password saved |

## Decision (ADR-0010)
Passwords live in **both** places (product owner, 2026-11-24):
1. **Northstar's credential vault:** encrypted, used only by the Apply Gateway for automation.
2. **Your password manager:** every new account is mirrored there so you can always sign in
   yourself (manager TBD, Q-16).

This supersedes the "no server-side passwords" parts of APPLY-010 and NFR-SEC-003, with the
stronger controls below.

## Requirements

### Account automation
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| ACC-001 | M | P1 | **Tenant registry.** Track each employer tenant (ATS type, tenant URL, account email, status `none / creating / verifying / active / locked / needs_human`, created/last-login dates, linked applications). Shown in Settings → Accounts. |
| ACC-002 | M | P1 | **Auto account creation.** When a queued application needs an account on a tenant without one, the Apply Gateway creates it: canonical profile data (name, email, phone, address from settings), a generated unique password (≥ 20 chars, per-tenant), and the tenant's required consents per the user's consent policy (ACC-008). |
| ACC-003 | M | P1 | **Auto sign-in** on known tenants, with session reuse while valid. Failed sign-in leads to an auto reset (ACC-005), then `needs_human` if that fails. |
| ACC-004 | M | P1 | **Workday adapter** handles the standard multi-step flow (My Information, My Experience with resume upload and parse-correction, Application Questions, Voluntary Disclosures, Self Identify, Review). Field mapping comes from the profile graph; EEO answers come only from explicit settings (APPLY-012). |
| ACC-005 | S | P1 | **Password reset by email.** Use the tenant's forgot-password flow plus the Verification Catcher; rotate and save the new password to both stores. |
| ACC-006 | M | P1 | **Duplicate-account safety.** Before creating, check the registry and attempt sign-in, so a second account is never created on a tenant. |
| ACC-007 | M | P1 | **Challenges hand off.** CAPTCHA, SMS or phone verification, or an unexpected security prompt pauses the flow and raises a 1-click handoff that opens the exact page, pre-filled, in your browser (ADR-0003). After you finish, the gateway resumes and records the session. |
| ACC-008 | M | P1 | **Consent policy.** One-time settings choice: "Accept standard candidate terms and privacy notices automatically" (default **on**) or "Ask me per tenant". Every accepted notice is recorded with a snapshot of its text, URL and timestamp. Marketing opt-ins are always declined. |
| ACC-009 | S | P2 | **Account hygiene:** list of all tenant accounts, last-used dates, one-click "delete my candidate account" helper where the tenant supports it, and an export of the registry. |
| ACC-010 | C | P2 | **Third-party sign-in** ("Sign in with Google/LinkedIn") is used only when the tenant offers it **and** the user enables it per provider. Off by default. |

### Email verification ("Verification Catcher")
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| VER-001 | M | P1 | When an apply, sign-up or sign-in step expects an email check, the gateway opens a **verification window** (default 10 min) bound to that session: expected sender domain(s), tenant, purpose. |
| VER-002 | M | P1 | The Inbox pipeline (Gmail push) routes matching messages straight to the waiting session: sender domain must match the tenant or ATS allowlist, the message must arrive inside the window, and it's consumed once. |
| VER-003 | M | P1 | **Deterministic extraction first:** regex and HTML parsing for codes (4–8 digits/alnum) and verification links. An LLM fallback (extraction only, no tools) runs only on mismatch, and its output is validated by the same pattern rules. |
| VER-004 | M | P1 | **Link safety:** magic links are opened only if the link's host matches the tenant or ATS allowlist (after resolving redirects). Anything else becomes `needs_human`. |
| VER-005 | M | P1 | Codes and links are **never logged, never shown in the activity feed, never stored** beyond the session (the feed says "Verified email for Acme (Workday)"). Messages are labeled `Northstar/Verification` and archived after use. |
| VER-006 | M | P1 | No matching email in the window: retry "resend code" once, then raise `needs_human` with what was expected. |
| VER-007 | M | P1 | **Tagged applicant address.** When Northstar submits, it uses a plus-address `<you>+ns-<code>@gmail.com` (Gmail delivers it to the normal inbox). `<code>` is a short random tag (6 base32 characters) mapped to the application in the database; it never contains the company name or anything guessable. Where the employer needs an account (ACC-*), the tag is per tenant, because the account email must stay fixed; otherwise it's per application. If a form rejects `+`, use the plain address and rely on INB-009 steps 2–3. Feeds INB-009 and INB-004. |

### Credential vault (ADR-0010)
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| CRD-001 | M | P1 | Envelope encryption: a data key per secret, wrapped by a master key held outside the database (local: a key file on your machine, never in the repo; hosted: cloud KMS). Database dumps alone reveal nothing. |
| CRD-002 | M | P1 | **Only the Apply Gateway** can decrypt, at the moment of use. Agents, the API, logs, traces, prompts and the UI never see plaintext. The UI can reveal a password only after a fresh passkey check. |
| CRD-003 | M | P1 | Every decrypt is audit-logged (who, tenant, purpose, approval or policy ID). |
| CRD-004 | M | P1 | **Mirror to your password manager** on create and rotate (Bitwarden CLI or 1Password service account, Q-16). A mirror failure doesn't block the application but raises a visible fix-it item. |
| CRD-005 | S | P1 | **Kill switch:** "lock vault" stops all automated sign-ins immediately (RES-008). |

## Acceptance criteria (selected)
- **ACC-002/VER-002:** Against a recorded Workday fixture, a new-tenant application goes from queued
  to `package_ready` with account created and email verified, with zero human actions.
- **ACC-006:** Running the same new-tenant flow twice creates exactly one account.
- **VER-004:** A verification email whose link points to a non-allowlisted host is never opened,
  and raises `needs_human`.
- **VER-005:** Searching logs, traces and the events table after a verified flow finds no code or link.
- **CRD-002:** A test proves the API and agent packages can't import the vault's decrypt function
  (dependency boundary rule).
