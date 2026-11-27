# NS-192 (slice 2): A one-time grant from Paul's session lets the extension read one handoff's package

Status: in progress
Requirements: APPLY-006, ACC-007 · ADR-0029 (Accepted, option 2), ADR-0019, ADR-0018, ADR-0002, ADR-0003
Rules that apply: ADR-0016, `.claude/rules/gateways.md`, `.claude/rules/api.md` (if present), `.claude/rules/tests.md`.
Parent: #20, issue #161.

## Why
When a CAPTCHA, sign-in or verification step stops a submission, the "Save to Northstar" extension
should fill the form in Paul's own tab with the package he already approved. Slice 1 stores the
package and `readHandoffPackage` re-checks it on every read. ADR-0029 option 2 allows the extension
to read it only with a one-time, 2-minute grant that Paul's own session issues, so a leaked
extension token alone still reads nothing. This slice adds the two endpoints.

## Behavior
`apps/api/src/prefill.ts`:
- **The grant store, `createPrefillGrants`.** It is in memory, like sessions and passkey challenges,
  and a restart forgets it, which only means Paul clicks again.
  - `issue(handoffId)` makes 32 random bytes (base64url) and keeps only their SHA-256, bound to that
    handoff, for 2 minutes. At most 20 wait at once, and the oldest is dropped first.
  - `consume(grant, handoffId)` uses the grant up whatever the answer. It holds only if the grant
    was issued for that handoff and hasn't expired.
- **`POST /handoffs/prefill-grant`** (`auth: "session"`, `{ handoffId }`). It first checks that
  `readHandoffPackage` would serve the handoff, so a grant is never issued for one it would refuse.
  It answers `{ grant, expiresAt }`, or the refusal code.
- **`POST /handoffs/package`** (`auth: "extension"`, a 512-byte body limit, `{ handoffId, grant }`).
  - It consumes the grant first. A missing, wrong, used or expired grant is `403 grant_invalid`,
    with no database read.
  - Then it calls `readHandoffPackage` at that moment and answers with the handoff id, application
    id, ATS, apply URL, contact and fields. Files are never sent.
  - Refusals:

    | Refusal | Code |
    | --- | --- |
    | `not_found` | 404 |
    | `closed` | 409 |
    | `no_package` | 409 |
    | `not_approved` | 409 |
    | `changed` | 409 |

- **Never logged.** Neither endpoint lists handoffs. No grant, field value, contact detail or URL
  goes in a span, log or error. Spans carry the outcome code only.

## Acceptance criteria
- [ ] The extension token without a grant, or with a wrong, used, expired or other handoff's grant,
      gets `403 grant_invalid` and the package is never read.
- [ ] A grant works once: a second read with it is refused.
- [ ] A grant is 2 minutes long: at 2 minutes and 1 ms it is refused (fake clock).
- [ ] The package endpoint refuses a session cookie without the extension token (401), and the grant
      endpoint refuses the extension token (401).
- [ ] The grant endpoint refuses a closed, packageless, unapproved or changed handoff with its code,
      and issues nothing.
- [ ] A served package is exactly `readHandoffPackage`'s fields. The grant store keeps only hashes.
- [ ] `pnpm turbo run lint typecheck test build` is green for `apps/api`.

## Failure modes
- The database is down: the endpoint answers 500, and the grant is already used, so Paul clicks again.
- A restart loses the waiting grants, so Paul clicks again.

## Observability
`api.request` spans with the outcome code. No event: `handoff.prefilled` comes with the extension's
fill in slice 3.

## Out of scope
- The card's pre-fill link in the web app.
- The extension's fill (only adapter-mapped fields on the adapter's hosts, never submit), and
  `handoff.prefilled`.

## Decisions made without Paul
- The grant is held in the API's memory, not a database table. ADR-0029 names "a short-lived table"
  as the cost, but its decision only asks that the grant be random, stored hashed, single use and
  2 minutes long. The API already keeps sessions and passkey challenges in memory, the migration
  lane is held by another agent, and a 2-minute grant has nothing to survive a restart for.
