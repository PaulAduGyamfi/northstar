# NS-146: Store tailored resumes per application and add a tailor command

Status: accepted (autonomous lane, ADR-0016)
Requirements: TLR-001, TLR-003, TLR-005 (with TLR-002, TLR-004 from NS-117/NS-145)
Rules that apply: ADR-0004, ADR-0012, ADR-0016, ADR-0020, `.claude/rules/db.md`, `.claude/rules/tests.md`
Parent: #16 (NS-117)

## Why
NS-117 and NS-145 built resume tailoring as pure functions: select and order the master's atoms
for a job, validate provenance, render a one-page PDF, diff it against the master and score it
before sending. Nothing reads a real job or keeps what was made, so Paul can't use it.

## Behavior
1. **Reader** (`packages/db`, `readTailorInput(db, candidateId, jobId)`): the current resume
   import's roles (id, employer, title, locked dates), education, atoms (id, role, what, how,
   verbatim resume line) and skills, in resume order, and the job's title, requirements and
   nice-to-haves. `NoProfile` before any resume import; `JobNotFound` for an unknown id or
   another candidate's job; `JobNotReady` for a draft.
2. **Store** (`tailored_resume`, append-only, one migration plus its trigger): one row per
   version, per job (`version` 1, 2, … per job). Each row holds the tailored resume, the
   validator result, the pre-send score, the skills Paul turned off, and the resume import and
   job it came from. Saving what the newest version already holds (same import, same resume,
   same toggles) stores nothing. Keyed by job: a job has at most one application
   (`application_one_per_job`), and nothing creates applications yet.
3. **Run** (`packages/profile`, `tailorForJob`, plain code, no model): `tailorToPages` (one page),
   then Paul's toggles (`applySkillToggles`; only added skills can be turned off), re-render the
   PDF, `validateTailoredResume`, `preSendScoreFromPdf` and `diffResume`, then save.
4. **CLI** (Paul only, it prints his real profile): `profile tailor <job-id> [--drop <skill,skill>]`
   prints the diff (dropped, moved and reworded lines; added and removed skills), the not-claimed
   requirements, the pre-send score and the validator result, and the version saved.
5. **Event** `resume.tailored` and span `resume.tailor`: ids, version, counts (lines, atoms, added
   and dropped skills, not-claimed requirements), keyword coverage, the title match, the ATS pass
   and the validator's pass and failure count. Never resume, requirement, skill or atom text.

## Acceptance criteria
- [ ] Tailoring a ready job stores version 1; tailoring it again unchanged stores nothing; a
      different `--drop` stores version 2.
- [ ] A skill the master already lists can't be dropped (refused, nothing stored).
- [ ] An unknown job, another candidate's job, a draft and no resume import are refused by name.
- [ ] Versions are append-only (UPDATE, DELETE, TRUNCATE refused) and per candidate.
- [ ] The event carries ids, counts and flags only (a test checks no resume or job text in it).

## Failure modes
None outbound: no model, no network. A resume that can't fit one page comes back with its page
count (the existing `tailorToPages` behavior) and is still shown and stored with its score.

## Observability
`resume.tailored` event (feed line from its reason, numbers and fixed words only) and the
`resume.tailor` span.

## Out of scope
- The model route (`tailorWithModel`, off by default) and choosing it per job.
- Storing the PDF/DOCX files (object storage arrives with package assembly, NS-161).
- A tailor view in the app.
