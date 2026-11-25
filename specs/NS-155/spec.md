# NS-155: Store Paul's approved positioning thesis versions

Status: accepted (autonomous lane, ADR-0016)
Requirements: DX-009
Rules that apply: ADR-0004, ADR-0012, ADR-0016, `.claude/rules/db.md`
Parent: #26 (NS-127)

## Why
NS-127 merged `checkThesis` (plain-code provenance check of a one-sentence positioning thesis) but
took its storage out of that PR, because only one agent at a time may add migrations. Paul's
approved thesis needs to be stored as versions so later work (drafting, the CLI, the gap-to-proof
narrative in NS-152) can read the current one and its history.

## Behavior
Restored from branch `ns-127` (commit `bae0b2c`, reviewed there), with migrations regenerated at
the next free numbers after merging the latest `main`:
- `positioning_thesis`: one row per version per candidate; text of 1 to 200 characters with no
  CR or LF. `positioning_thesis_atom`: the atoms a version cites, foreign keys to the same
  candidate. Both are append-only (triggers refuse UPDATE, DELETE and TRUNCATE), and a deferred
  trigger requires every version to cite at least one atom.
- `thesis-write.ts`:
  - `saveApprovedThesis` takes atoms from the current resume import only. The same text with the
    same atoms stores nothing; the same text with other atoms is a new version. It writes a
    `thesis.approved` event (version and atom count, never the text), checked with
    `parseDomainEvent`.
  - `readCurrentThesis` and `readThesisHistory`.
- Callers run `checkThesis` (`packages/profile`) before saving; `packages/db` can't import it.

## Acceptance criteria
- [ ] The restored tests in `packages/db/src/thesis.test.ts` pass on PGlite against the
      regenerated migrations.
- [ ] `db:generate` reports no schema changes after the new migrations.
- [ ] The `thesis.approved` event shows in the feed as its reason sentence ("Paul approved a
      positioning thesis", the same style as stories and answers), so it needs no template.
- [ ] `.claude/rules/db.md` has the thesis bullet (#96) and AGENTS.md mentions the storage.

## Failure modes
- Database down: the save throws; nothing is half-written (one transaction).
- An atom from an older resume import: refused, nothing stored.

## Observability
- `thesis.approved` event with version and atom count; the write path's span.

## Out of scope
- Drafting, the guided session and the CLI (NS-152, #95).
