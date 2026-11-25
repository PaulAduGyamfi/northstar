# NS-158: Link job mail to applications (slice 1: tags, deterministic matching, links)

Status: accepted (autonomous lane, ADR-0016)
Requirements: VER-007, INB-004 (link only), INB-009, INB-011, INB-012
Rules that apply: ADR-0012, ADR-0014, ADR-0016, `.claude/rules/db.md`

## Why
The P1 exit criterion says every reply lands on the right application. Today job mail is read
and classified (NS-113) but never tied to an application. This slice gives each application an
unguessable plus-address tag and a plain-code matcher that links an email to its application,
or puts it in a "confirm link" queue, never a guess.

## Behavior
1. **Tags (VER-007).** `generateTag()` returns 6 base32 characters from `crypto.randomInt`
   (30 bits; never derived from the company or anything guessable). `mail_tag` (packages/db)
   maps a tag to exactly one application or one tenant key (`workday:acme`), unique per
   candidate, append-only. `assignApplicationTag` gives an application its tag once (a repeat
   returns the same tag); `assignTenantTag` does the same per tenant. `taggedAddress(base, tag)`
   builds `<local>+ns-<tag>@<domain>`.
2. **Reading the tag (INB-011).** `tagFromDeliveredTo` reads `+ns-<tag>` only from the
   Gmail-added `Delivered-To` header, never `To`/`Cc`, case-insensitive, and only a well-formed
   6-character base32 tag.
3. **Matching (INB-009), plain code, no model, first hit wins:**
   1. *Tag.* An application tag links to it. A tenant tag narrows the candidates to that
      tenant's applications; steps 2–3 then choose among them, or it goes to the queue. An
      unknown `+ns-` tag always goes to the queue.
   2. *Thread.* The Gmail thread of an earlier deterministic link to exactly one application.
   3. *Authenticated sender.* An authenticated domain (DMARC pass or DKIM pass, read with
      `authenticatedDomains`) under exactly one candidate's company or ATS domains, received
      inside that application's active window. Never the `From:` header.
   Anything else, or more than one hit at a step, goes to the confirm queue with a reason
   (`unknown_tag`, `ambiguous`, `no_match`). Each result records the step that made it.
4. **A tag is not proof of the sender (INB-011).** Each link carries `senderVerified`: true only
   when an authenticated domain is under the application's allowlisted domains. P1 never
   changes a status from email (INB-004); `senderVerified` is what a later status change
   (P2) must require.
5. **Storage.** `mail_link` (packages/db, append-only): one row per Gmail message id and
   candidate, with the application (or none), the step or the queue reason, and
   `sender_verified`. `recordMailLink` is idempotent per message id. `listConfirmQueue` returns
   the queued ones, oldest first. Events `mail.linked` and `mail.link_queued` carry the message
   id, step or reason and application id only, never an address, subject, sender or body; both
   have feed lines.
6. **Verification mail first (INB-012).** `matchMail` refuses (returns `skip`) a message that
   `isVerificationMail` flags, so it is never linked or queued; the Verification Catcher owns it.

## Acceptance criteria
- [ ] Mail delivered to `candidate+ns-<tag>@example.com` links to its application with step
      `tag` (fixture test, no model).
- [ ] An unknown tag goes to the queue (`unknown_tag`); a tag in `To:` but not `Delivered-To`
      isn't read.
- [ ] A tenant tag shared by two applications links only when step 2 or 3 picks one; otherwise
      `ambiguous`.
- [ ] A forged `From:` with no DMARC/DKIM pass never matches at step 3, and a tagged link from an
      unauthenticated sender has `senderVerified: false`.
- [ ] Step 2 links a reply in a thread already linked to one application.
- [ ] Verification mail is skipped.
- [ ] `recordMailLink` twice stores one row and one event; tables refuse UPDATE/DELETE/TRUNCATE.
- [ ] Tags are unique per candidate and an application keeps its first tag.

## Failure modes
- Database down: matching is pure; recording throws and the caller retries the message later
  (idempotent per message id).
- A tag collision on insert (1 in 10^9 per pair): retried with a new tag, up to 3 times.

## Observability
- `mail.linked` / `mail.link_queued` events with ids, step and reason; spans `db.mail_link.record`
  and `db.mail_tag.assign`.

## Out of scope (follow-up issues)
- INB-007 `started_by` / `submitted_via` written through `transitionApplication`, and INB-010's
  credit report by origin.
- The Apply Gateway putting the tagged address on forms (VER-007's use), and the mail-reading
  loop that calls `matchMail` and `recordMailLink` (needs the worker or a CLI).
- The confirm-queue UI; any model-proposed match (INB-009 step 4).
