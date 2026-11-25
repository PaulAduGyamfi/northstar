# NS-152: Guided thesis session and CLI (slice 1)

Status: accepted (autonomous lane, ADR-0016)
Requirements: DX-009 (DX-010 split out, see below)
Rules that apply: ADR-0004, ADR-0013, ADR-0016 (item 8), `.claude/rules/llm.md`, `.claude/rules/db.md`
Parent: #26 (NS-127)

## Why
NS-127 built `checkThesis` and NS-155 stores Paul's approved thesis versions, but nothing drafts
a thesis or lets Paul set or see one. This slice adds the guided draft and the CLI.

## Behavior
1. **`readThesisProfile`** (packages/db, read-only): the current resume import's roles (employer,
   title, locked dates, current), its atoms (id, role, verbatim `source_quote`) and skills, or
   null before any import.
2. **`thesisEvidence(profile, atomIds, asOf)`** (packages/profile): the `checkThesis` evidence for
   a thesis citing those atoms: the cited atoms' quotes, all roles and skills. Unknown atom ids
   are reported, never ignored.
3. **Route `positioning-thesis`** (`packages/profile/src/thesis-draft.ts`, prompt
   `positioning-thesis/v1.md`): Paul's roles, atoms (by id, quoted) and skills in, up to three
   candidate theses out, each with the atom ids it cites. The profile is Paul's text but may hold
   pasted material, so it goes in `untrustedBlock`. No tools.
4. **`draftTheses({ gateway, enabled }, profile, asOf)`**: off by default (ADR-0016 item 8:
   hand-written fixtures). When on, every candidate is run through `checkThesis` with
   `thesisEvidence`; only passing ones are returned, with the count dropped. Nothing is saved:
   Paul chooses and saves with `thesis set`.
5. **CLI** (Paul only; agents never run it on real data):
   - `profile thesis draft`: prints the passing candidates and their atom ids, or says drafting is
     off.
   - `profile thesis set "<text>" --atoms <id,id>`: runs `checkThesis`; on any failure prints
     each failure and saves nothing (exit 1); otherwise `saveApprovedThesis` and prints the
     version (or that it is unchanged).
   - `profile thesis show`: the current thesis, its version and cited atom ids.

## Acceptance criteria
- [ ] `readThesisProfile` returns roles with locked dates, atoms with ids and quotes, and skills;
      null before an import.
- [ ] `thesisEvidence` quotes only the cited atoms and reports unknown ids.
- [ ] `draftTheses` is off by default with no call; when on it drops a candidate that fails
      `checkThesis` (an unbacked number or name) or cites an unknown atom, and keeps one that
      passes.
- [ ] `thesis set` refuses a thesis with an unbacked number and saves nothing; saves a passing
      one and prints its version; reports an unknown atom id.
- [ ] `thesis show` and `thesis draft` print as specified, and bad arguments print the usage.
- [ ] Eval set `evals/positioning-thesis/` (synthetic, hand-written fixtures, provisional
      baseline) runs in `eval --all`.

## Out of scope (follow-up issues)
- DX-010 gap-to-proof: independent-work entries with provenance (a new table, so a migration),
  the "Projects / Independent work" section and the 20-second answer.
- Feeding the thesis into the resume summary, headline, pitch and outreach as those land.
- Recording real fixtures and turning drafting on (`needs:paul`).
