# NS-127: Positioning thesis (slice 1: the provenance check)

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: DX-009, in part (a one-sentence thesis, versioned, which later drives the resume
summary, headline, pitch and outreach). The guided session, DX-010 and the consumers are split
into follow-up issues (see "Out of scope"). GitHub issue #26.
Rules that apply: ADR-0004 (no fabrication; every claim cites atoms; locked facts never change),
AGENTS.md (code decides, the model drafts; public repo, synthetic fixtures only), ADR-0012,
`.claude/rules/db.md`, `.claude/rules/tests.md`.

## Why
Paul's resume summary, LinkedIn headline, screen pitch and outreach should all tell one story
(H4 positioning). The first step is a single sentence he approves, which every generator can
then quote. Like everything else, it may claim only what his profile backs up.

## Behavior
1. **`checkThesis(text, evidence)`** (`packages/profile`, `thesis.ts`, plain code). The evidence
   is the cited atoms' `sourceQuote`, the roles (employer, title, start, end, current), the
   skills and the date to measure years against. It returns a list of failures and passes only
   when that list is empty:
   - `no_citation`: no atom is cited.
   - `not_one_sentence`: empty, over 200 characters, a line break, or more than one sentence.
   - `unbacked_number`: a number that isn't in a cited quote. A plain "N years" (or "N+ years")
     may instead be at most the whole years of experience the roles' locked dates give, but
     only where every place the number appears is such a claim. "N years of <Name>" is not
     exempt, because the dates can't say what the years were spent on.
   - `unbacked_name`: any capitalised word, the first included (a company, product, technology
     or title word), that isn't in a cited quote, a role's employer or title, or the skills.
     Matching uses whole words and is case-sensitive.
2. **Stored versions: moved to a follow-up.** ADR-0016 (amended 2026-11-25) lets one agent at a
   time change `packages/db` migrations, and NS-120 is adding one. The storage below was built
   and reviewed, then taken out of this PR. It waits for NS-120 to merge, and nothing in this
   slice depends on it. Planned design: `positioning_thesis` and `positioning_thesis_atom`,
   written through `thesis-write.ts`.
   - `saveApprovedThesis` stores the text Paul approved as the next version, with the atoms it
     cites (at least one, from his current resume), and writes one `thesis.approved` event. The
     event carries the version and the atom count, never the text.
   - Saving the current text with the same atoms again stores nothing. The same text citing other
     atoms (say after a re-import) is a new version.
   - `readCurrentThesis` returns the newest version, and `readThesisHistory` returns all of them.
   - Both tables are append-only (a trigger), like approved stories.

## Acceptance criteria
- [ ] A thesis backed by its atoms and roles passes. "4 years" passes when the roles span 4 or
      more whole years. A number, company or technology not in the evidence fails with its kind
      and the offending token. Two sentences, an empty text and over-length text fail
      (profile tests).
- [ ] (Follow-up, with storage.) Saving gives versions 1, 2, …; the same text and atoms twice
      store one version. A thesis with no atom, or another candidate's atom, is refused. The
      event has no text. The rows can't be updated or deleted.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **The check misses a claim** written in plain words ("doubled", "led a large team"). It
  checks digits and names only, so Paul's approval is the backstop (the same limit as
  ADR-0004).
- **Sentence detection splits "Inc." or "e.g."** and reports `not_one_sentence`. That errs on
  the side of asking Paul to reword.
- No I/O in this slice, so no dependency can be down.

## Observability
None in this slice: a pure function. The storage follow-up writes `thesis.approved` (version and
atom count, never the text).

## Out of scope (follow-up issues, `agent-filed`, `Parent: #26`)
- Storing Paul's approved versions (above), once NS-120's migration has merged.
- The guided session and a `positioning-thesis` model route that drafts candidate theses from
  the profile, checked by `checkThesis` (DX-009). It needs hand-written fixtures, and Paul
  records real ones.
- The CLI for Paul (`profile thesis set/show`), and A/B variants (DX-006).
- The gap-to-proof narrative: independent-work entries and the 20-second answer (DX-010).
- Feeding the thesis into the resume summary (NS-117), the LinkedIn headline, the pitch and
  outreach.

## Open questions
1. **Capitalised words** are treated as claims, the first word included. A capitalised everyday
   word ("Backend") fails unless the evidence names it. That's strict on purpose: "Globex
   engineer…" must not pass.
2. **Years of experience** sums each role's span from its locked dates, overlaps counted once.
   A year-only date counts as January at either end, the shortest span it can mean.
3. **Not enforced by the database:** citations attached to an older version later (the only
   write path never does this), and the check itself, which the caller runs because
   `packages/db` can't import `packages/profile`. The CLI follow-up must run `checkThesis`
   before it saves.
