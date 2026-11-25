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
   candidate, append-only. `assignTag({ target })` gives an application or a tenant its tag once
   (a repeat returns the same tag; a colliding new tag is retried with a fresh one). `taggedAddress(base, tag)`
   builds `<local>+ns-<tag>@<domain>`.
2. **Reading the tag (INB-011).** `tagFromDeliveredTo` reads `+ns-<tag>` only from the
   Gmail-added `Delivered-To` header, never `To`/`Cc`, case-insensitive, and only a well-formed
   6-character base32 tag.
3. **Matching (INB-009), plain code, no model, first hit wins:**
   1. *Tag.* An application tag links to it. A tenant tag narrows the candidates to that
      tenant's applications; steps 2–3 then choose among them, or it goes to the queue. An
      unknown `+ns-` tag always goes to the queue.
   2. *Thread.* The Gmail thread of an earlier deterministic link to exactly one application.
   3. *Authenticated sender.* A verified domain (a DMARC pass, or a DKIM pass aligned with the
      From domain) under exactly one candidate's **own company domains**, received inside that
      application's active window. Shared ATS and freemail domains never count as a company's
      own, whatever the caller passes: one signs mail for every company on it, so it would pick
      the wrong application (untagged ATS mail goes to the queue instead). A caller may pass a
      per-tenant ATS host such as `acme.myworkdayjobs.com` as a company domain. Never the
      `From:` header alone.
   Anything else, or more than one hit at a step, goes to the confirm queue with a reason
   (`unknown_tag`, `ambiguous`, `no_match`). Each result records the step that made it.
4. **A tag is not proof of the sender (INB-011).** Each link carries `senderVerified`: true only
   when a DMARC pass or an aligned DKIM pass is for a domain under the application's company or
   ATS domains. An unaligned DKIM pass (a shared ATS signing someone else's From) never counts.
   A replayed, genuinely signed email can still verify, so P2 must not change a status on this
   flag alone. P1 never
   changes a status from email (INB-004); `senderVerified` is what a later status change
   (P2) must require.
5. **Storage.** `mail_link` (packages/db, append-only): one row per Gmail message id and
   candidate, with the application (or none), the step or the queue reason, and
   `sender_verified`. `recordMailLink` is idempotent per message id. `listConfirmQueue` returns
   the queued ones, oldest first. Events `mail.linked` and `mail.link_queued` carry the message
   id, step or reason, application id and `senderVerified` only, never an address, subject, sender or body; both
   have feed lines.
6. **Verification mail first (INB-012).** `matchMail` refuses (returns `skip`) a message that
   `isVerificationMail` flags (an ATS sender with a verification subject), so it is never linked
   or queued; the Verification Catcher owns it. Other verification mail may still be linked, but
   a link stores only ids, a step and a reason, never a code or link.

## Acceptance criteria
- [ ] Mail delivered to `candidate+ns-<tag>@example.com` links to its application with step
      `tag` (INB-009's acceptance text calls it `plus_tag`; the code says `tag`) (fixture test,
      no model).
- [ ] An unknown tag goes to the queue (`unknown_tag`); a tag in `To:` but not `Delivered-To`
      isn't read.
- [ ] A tenant tag shared by two applications links only when step 2 or 3 picks one; otherwise
      `ambiguous`.
- [ ] A forged `From:` with no DMARC/DKIM pass, or with only an unaligned DKIM pass, never
      matches at step 3, and a tagged link from such a sender has `senderVerified: false`.
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
- INB-009's "an email to a known tag always passes the INB-002 pre-filter", which belongs in the
  mail loop.
- Reading Gmail's own `Delivered-To` / `Authentication-Results` explicitly (gmail.ts takes the
  first, which Gmail puts on top; NS-160 item 2 covers the Authentication-Results half).
