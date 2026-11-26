# NS-222: `profile voice` commands: measure samples, store the profile and review its phrases

Status: building
Requirements: ANS-007 (voice profile from Paul's writing, reviewed by him)
Rules that apply: ADR-0016, `.claude/rules/db.md` (the voice profile), `.claude/rules/tests.md`.
Parent: #144. Builds on NS-136 (`measureVoice`) and NS-185 (storage).

## Why
NS-185 stores the voice profile and Paul's review, and `loadVoice` gives drafting its guide only
from a reviewed version. Nothing lets Paul make or review one, so the guide never exists.

## Behavior
- **`profile voice <file> <file> …`** reads 5–10 samples with `fileToText` and runs
  `measureVoice`. It prints the guide (`renderVoiceGuide`) and the phrases to review, then
  "Nothing stored." with the command to store it. **`--save`** before the files stores it as the
  next version (`saveVoiceProfile`) and says to review it. A problem from `measureVoice` (too few
  or too many samples, an empty file) stores nothing and exits 1.
- **`profile voice review`** with no flags lists the newest version's phrases and whether it's
  reviewed, and how to decide them. **`--keep <phrase,phrase>` and/or `--drop <phrase,phrase>`**
  decide every phrase of the newest version (`reviewVoiceProfile`). A phrase left undecided, named
  twice or not in the version stores nothing and names the problem. A version with no phrases is
  reviewed by `review` alone (there's nothing to decide).
- **`readNewestVoice(db, candidateId)`** (`packages/db`, `voice-write.ts`): the newest version's
  number and phrases and whether it has a review, or null. Read-only.
- Its own usage line, like `profile work` and `profile growth`, so the top-level usage asserted in
  `cli.test.ts` doesn't change. Paul only (his real writing); agents never run it. A row in
  AGENTS.md's command table.

## Acceptance criteria
- [ ] Preview stores nothing; `--save` stores once and prints counts and the guide; a
      `measureVoice` problem stores nothing (CLI tests on fakes).
- [ ] `review` lists, decides, and refuses an incomplete or unknown decision; an empty version is
      reviewed by `review` alone (CLI tests).
- [ ] `readNewestVoice` returns null, then the newest version, reviewed or not (PGlite).
- [ ] `pnpm turbo run lint typecheck test build` passes.

## Out of scope
- Recording edits from approvals (`recordEdit` has no caller yet; that's the answer flow's).
