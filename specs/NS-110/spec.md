# NS-110: Candidate profile graph: resume import into experience atoms

Status: approved by Paul (2026-11-24; resume only, mammoth + unpdf, atoms usable on import, Paul records eval fixtures before merge, one PR)
Requirements: CPG-001 (resume part), CPG-002 (experience atoms), CPG-004 (locked facts), ADR-0004
(profile graph and provenance), NFR-AIQ-001/002/003, OBS-001, RES-006. GitHub issue #9.
Rules that apply: AGENTS.md (no fabrication, untrusted text is data, code decides, public repo:
synthetic fixtures only, dependencies ask Paul), `.claude/rules/llm.md`, `.claude/rules/db.md`,
`.claude/rules/tests.md`, ADR-0012, ADR-0013.

## Why
Every generator in Northstar (tailoring, answers, outreach, profile copy) may only use Paul's real
experience (ADR-0004). Today there is nowhere to keep it. After this ticket, Paul runs one command
on his master resume, which lives in the gitignored `data/` folder. Northstar turns it into a graph:
- roles and education whose facts are locked;
- experience atoms, each tied to the exact resume sentence it came from;
- skills, certifications and links.

Generators in later tickets cite those atoms, and a deterministic check proves no atom says
anything the resume didn't.

## Scope (recommended; see open question 1)
NS-110 covers the **resume** path end to end. The LinkedIn export, GitHub repos and personal site
become follow-up tickets, each with its own parser and untrusted-text review.

## Behavior
**Schema (`packages/db`, new migration)**, every row with `candidate_id` (Q-02):
- `profile_source`: one import, with the kind (`resume` for now), file name, the SHA-256 of the
  extracted text (re-importing the same text is a no-op), when, and `superseded_at`.
- `role`: employer, title, start and end month, and `locked` (default true).
- `education`: school, degree, field, start and end, and `locked` (default true).
- `experience_atom` (CPG-002):
  - **what**: the claim in a few words;
  - **how**: the stack, a text array;
  - **impact**: only if the resume states it;
  - **scope**: team, users or scale, only if stated;
  - start and end month;
  - `role_id` (optional) and `source_id`;
  - **`source_quote`**: the exact resume sentence it came from;
  - `evidence_link` (optional).
- `skill`, `certification`, `profile_link`.

**Locked facts (CPG-004), enforced in the database:** a trigger rejects any `UPDATE` that changes
`employer`, `title`, `start_month` or `end_month` on a locked `role`, or `school`, `degree` or the
dates on locked `education`. The only exception is a transaction that has set
`northstar.locked_edit = 'user'`. Only the `editLockedFact` write path sets it, and only for an
edit Paul makes himself. Generators never use that path.

**Prompts (`packages/prompts`, first package of its kind):**
- versioned files (`profile-extract/v1.md`) loaded by id and version;
- a committed `prompts.lock.json` with the SHA-256 of every versioned file;
- a test that fails if a committed version's text changes. New text needs a new version
  (llm.md: never edited in place).

**Extraction (`packages/profile`):**
- **Route:** `profile-extract` on the NS-106 gateway, at effort `medium`. It takes the resume text
  (in an `untrustedBlock`) and returns, as structured output: roles, education, atoms, skills,
  certifications and links. Every atom carries `source_quote`, the verbatim resume line it rests on.
- **Provenance check (NFR-AIQ-002):** a deterministic validator runs after every extraction. It
  rejects the result if any of these holds:
  - an atom's `source_quote` isn't found verbatim in the resume text (whitespace-normalised);
  - an atom's `impact` contains a number that isn't in its `source_quote`;
  - a role's employer or title isn't verbatim in the resume.

  A rejected result writes nothing and reports which items failed. No retry loop in this
  ticket: Paul fixes or re-runs.
- **File text:** `.txt`, `.md`, `.docx` (via `mammoth`) and `.pdf` (via `unpdf`). Both are new
  dependencies; see open question 2.
- **Import:** in one transaction, it marks the previous resume source superseded, writes the source,
  roles, education, atoms, skills, certifications and links, and appends one domain event:
  `profile.imported`, with counts only and no resume text (OBS-001). Re-importing the same text
  changes nothing (RES-006).
- **CLI:** `pnpm --filter @northstar/profile profile import-resume <path>`, with the path relative
  to where pnpm was run. Paul runs it, with
  `DATABASE_URL` and `ANTHROPIC_API_KEY` from `.env`. It prints counts and any validator failures,
  never resume text. `show` lists roles and atoms back for Paul to read.

**Eval set (`evals/profile-extract`, NFR-AIQ-001):** about 8 synthetic resumes (invented people
and companies, `example.com`):
- clean ones;
- a two-column layout;
- one with no metrics, which must give no invented impact;
- one with a prompt-injection line ("ignore previous instructions…"), which must be ignored;
- one with overlapping roles.

The grader checks the expected roles exactly and atom counts within a range, and runs the
provenance validator on every case. Paul records the fixtures once (`--record`, synthetic inputs
only) and commits them.

**CI:** the `checks` workflow gets a step that replays every registered eval
(`pnpm --filter evals eval --all`). Replay is offline and needs no secrets (ADR-0013). This is the
CI step NS-106 left for the first route.

## Acceptance criteria
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, with tests in db, prompts, profile
      and evals.
- [ ] DB tests (PGlite):
  - changing a locked role's employer, title or dates is rejected;
  - the same change through `editLockedFact` succeeds and appends an event;
  - every row needs a candidate.
- [ ] Validator tests:
  - a quote not in the text is rejected;
  - an invented number in `impact` is rejected;
  - an invented employer is rejected;
  - a clean extraction passes;
  - whitespace and line breaks in the resume don't cause false rejections.
- [ ] Import tests (fake gateway, synthetic text):
  - one transaction writes everything and one `profile.imported` event;
  - re-import of the same text writes nothing;
  - a new version supersedes the old source;
  - a validator failure writes nothing.
- [ ] Prompt lock test: changing a committed prompt version's text fails the test.
- [ ] `pnpm --filter evals eval profile-extract` replays at or above `baseline.json`. CI runs the
      replay step and it is green.
- [ ] Paul runs `import-resume` on his real resume locally. The counts look right to him, and
      `show` matches his resume. That output stays local; only "done" goes in the PR.
- [ ] No resume text appears in events, spans, logs or CLI output (tests check events and output).
- [ ] `checks` is green on the PR. The reviewer and security-reviewer find nothing critical (new
      dependencies, a prompt that reads document text).

### Later additions (after Paul's first real import showed "?" and a false "present")
- [ ] Dates keep the resume's precision: `YYYY-MM`, or `YYYY` for a year only, never a guessed
      month (Zod and a DB CHECK, migration 0006).
- [ ] `current` is its own locked fact (`role.is_current`, 0006, locked by the trigger in 0007).
      The validator accepts it only with "Present"/"Current"/"Now" after a dash or "to" near the
      employer, and never with an end date. The database refuses current plus an end date (0008).
- [ ] Every role date must sit within 120 characters of its employer, education dates near the
      school, a certification's date near its name (known limits in ADR-0004).
- [ ] `profile show` prints `present` only for a current role and `?` for an unknown date.
- [ ] `import-resume <path> --reimport` re-extracts an unchanged file and supersedes the current
      source. Paul's hand-corrected locked facts are not carried over (ADR-0004; NS-112).
- [ ] A missing file is reported as "not found at <path>".
- [ ] Fixture files store the request hash as `requestSha256`, so gitleaks doesn't read it as a key.

## Failure modes
- **Claude API down or rate-limited:** `LlmTransportError`. The CLI says to retry, and nothing is
  written.
- **Refusal or truncation:** reported with the call record, and nothing is written. A long resume
  that truncates means raising `maxTokens` (prompt v2) on evidence.
- **Invented or altered content:** the validator rejects the whole extraction and lists the items.
  Nothing is partly imported.
- **A corrupt or password-protected PDF or DOCX:** the text extractor fails with the file name.
- **Postgres down:** the CLI fails before calling the model (it checks the connection first), so no
  tokens are spent on an import that can't be saved.

## Observability
- One `profile.imported` event: source id, counts by kind, prompt version and model. No text.
- The `llm.call` span from the gateway, plus `profile.import` with counts and outcome.

## Out of scope (follow-up tickets, open question 1)
- LinkedIn export (CSV zip), GitHub repos, personal site.
- The story interview (NS-111) and employment-facts consistency (NS-112).
- Embeddings for atoms (pgvector) and a UI to review or edit atoms.
- An automatic retry when the validator rejects.

## Open questions
1. **Split CPG-001.** Recommended: NS-110 covers the resume only. Paul opens three follow-ups:
   - LinkedIn export, mostly deterministic CSV parsing;
   - GitHub repos, via the public API (read-only, no token);
   - personal site, which is untrusted web text.

   Alternative: all four sources here, about three times the size.
2. **Dependencies:** `mammoth` (DOCX to text) and `unpdf` (PDF to text), both exact versions at
   least 14 days old. Alternative: `.txt`/`.md` only, and Paul exports his resume to text. That
   fails CPG-001's "PDF/DOCX".
3. **Atom confirmation.** Inferred: atoms from Paul's own resume, each verbatim-anchored, are
   usable at once, with no draft state. Correcting or removing atoms waits for a review UI.
4. **Recording the eval fixtures** needs Paul's API key and costs a few cents (8 synthetic cases).
   Until he records them, the CI replay step would fail with `MissingFixture`. Recommended: Paul
   records before the PR merges.
5. **Diff size.** About 1,800 lines with tests and eval cases, over AGENTS.md's ~300.
