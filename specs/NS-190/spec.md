# NS-190: Store resume audits and Paul's accept/reject decisions, with a profile audit command

Status: accepted (autonomous lane, ADR-0016)
Requirements: AUD-001, AUD-002 (store an audit and Paul's decisions), AUD-003 (a missing result
is a question, never a proposed metric), CPG-004 (locked facts)
Rules that apply: ADR-0004, ADR-0012, ADR-0016, `.claude/rules/db.md`, `.claude/rules/tests.md`
Parent: #110

## Why
NS-159 built the audit as plain code (`auditResume`, `applySuggestion`), but nothing stores a
run, nothing lets Paul run it, and an accepted line goes nowhere. Paul wants to run
`profile audit`, see the scores and suggestions, and accept a suggestion with his own new line or
reject it. A rejected suggestion shouldn't come back on the next run, and an accepted line should
be the line the tailor uses from then on.

## Behavior
1. **Storage** (`packages/db`, `audit-schema.ts`, one migration plus a custom one for the
   triggers). All four tables are append-only (a trigger refuses UPDATE, DELETE and TRUNCATE), and
   every row has a `candidate_id`.
   - `resume_audit`: one row per run, holding the resume import it read (`profile_source_id`),
     its targets, its six scores, overall and pages.
   - `resume_audit_suggestion`: each suggestion of a run, under its stable key (`<kind>:<target>`
     from `auditResume`), with kind, dimension, target and message. The message holds no number
     of its own (NS-159).
   - `resume_audit_decision`: Paul's decision on one suggestion of one run, at most one each. It
     is `accepted` with his new line or `rejected` with no line; a CHECK holds that.
   - `atom_line_edit`: a new version of one atom's resume line, from an accepted decision. The
     atom row itself (its `source_quote`, the verbatim resume text the NS-110 provenance check
     relies on) never changes. The newest edit is the atom's current line. Its origin is the
     decision, and through it the audit, so provenance still traces back.
2. **Write paths** (`audit-write.ts`, the only writer of these tables):
   - `readAuditInput(db, candidateId)`: the current resume import, as `TailorMaster`, with each
     atom's newest edited line in place of its quote. It also returns the targets: the newest
     search preference's titles plus every ready job's requirements, de-duplicated. It returns
     `NoProfile` when there is no resume import.
   - `saveResumeAudit`: stores a run and its suggestions in one transaction. Event
     `resume.audited` carries the audit id, overall, suggestion count and target count: no text.
   - `rejectedKeys(db, candidateId, profileSourceId)`: the suggestion keys Paul rejected on this
     import, so a re-run leaves them out.
   - `decideSuggestion`:
     - It is refused when the suggestion is unknown, already decided, belongs to an audit of a
       superseded import, or is accepted without a line.
     - An acceptance writes the decision and the `atom_line_edit` together.
     - Event `resume.suggestion_decided` carries the audit id, the suggestion's kind and the
       decision: never the line or the message.
   - `readTailorInput` (NS-146) now also puts each atom's newest edited line in place of its
     quote, so a tailored resume uses Paul's line. Scoring, stories and the thesis still read the
     imported quote: they cite the resume itself.
3. **Command** (`packages/profile`, `audit-cli.ts`; Paul only, agents never run it):
   - `profile audit` runs `auditResume` on that input, leaves out the keys Paul rejected on this
     import, and stores the run. It prints the scores, then each suggestion with its key.
   - `profile audit accept <key> "<new line>"` checks the line with `applySuggestion` against the
     newest run's master (which refuses another role's employer, title or year, a multi-line text,
     an empty line and a non-line suggestion), then stores it.
   - `profile audit reject <key>` stores a rejection.
   - A malformed `audit` command prints its own usage line, like `tailor` and `settings`, so no
     existing assertion changes.

## Acceptance criteria
- [ ] A run and its suggestions are stored and read back, and its event carries no text (PGlite).
- [ ] An accepted suggestion stores the decision and one `atom_line_edit`, and changes only that
      atom's line in `readTailorInput` and `readAuditInput`; the atom row's quote is unchanged.
- [ ] A rejected key is left out of the next run on the same import; a new import brings it back.
- [ ] A second decision on the same suggestion, an unknown key, acceptance without a line, and an
      audit of a superseded import are each refused, naming why.
- [ ] Every table refuses UPDATE and DELETE.
- [ ] `profile audit accept` refuses a line naming another role's employer (`applySuggestion`)
      and stores nothing; `reject` and `accept` print what they stored. A malformed command
      prints the audit usage line.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
None outbound: database only. Postgres down: the command prints `safeErrorSummary` and stores
nothing (each write is one transaction).

## Observability
Events `resume.audited` and `resume.suggestion_decided`, with feed lines built from their numbers
and fixed words only. Spans `resume.audit` and `resume.audit_decide`.

## Out of scope
- Model-written wording suggestions (they would need their own route and eval set).
- An audit page in the app.
- Carrying edits across a re-import: a new import has new atoms, and its own audit starts fresh.

## Decisions made without Paul (ADR-0016)
- **Schema change:** four append-only tables, in one migration plus the trigger migration.
- **What "a new atom version" means:** the issue asks for the edit to be a new atom version.
  This stores it as an `atom_line_edit` row rather than a second `experience_atom` row. That
  keeps every story, thesis and score that cites the atom's id pointing at the same atom, and
  leaves the imported quote untouched for provenance.
- **`what` and `how`:** kept as imported. They describe the work, not the wording, and re-deriving
  them would need the model.
