# NS-117: Resume tailoring with provenance validator, diff and pre-send score (first slice)

Status: agent-approved under ADR-0016 (autonomous lane; Paul reviews after the fact)
Requirements: TLR-001, TLR-002, TLR-003, TLR-004 (this slice); TLR-005 and the model-written parts
of TLR-001 are follow-ups (below)
Rules that apply: ADR-0004 (provenance), ADR-0016, `.claude/rules/tests.md`; `llm.md` and `db.md`
only for the follow-ups

## Why
Fit scoring (NS-116) tells Paul which queued jobs he fits and which experience atoms prove it.
The next step of the core loop is a resume tuned to each job: the atoms that matter for it first,
the skills it asks for that he really has brought forward, and nothing he can't back up. Every
line must point at the atom it came from (ADR-0004), Paul must see what changed against his
master resume, and before anything is sent he gets a score: does it carry the job title, how many
of the job's requirements does it cover, and does it survive an ATS re-parse.

## Behavior
All of it is plain functions in `packages/profile/src/tailor/`: no model, no database, no
network. The master resume is the profile graph's records (roles, education, atoms, skills); the
job is its title, requirements and nice-to-haves (as `jobs add` stores them).

### Tailor (TLR-001, deterministic part)
`tailorResume(master, job, options)` returns a `TailoredResume`:
- **Terms.** An atom stands for its `how` items plus every master skill its own text (`what` or
  resume line) names as a whole word, the same rule fit scoring uses ("Go" isn't found in
  "Google", "C" isn't found in "C#").
- **Relevance.** An atom scores 2 for each must-have and 1 for each nice-to-have that names one
  of its terms.
- **Order.** Roles stay in resume order (dates are locked facts, CPG-004; reordering roles would
  misstate the timeline). Inside each role, and in the projects section (atoms without a role),
  atoms go by relevance, highest first, ties in resume order.
- **Lines.** Each line is the atom's own resume line, verbatim (bullet markers trimmed), citing
  that atom. The deterministic tailor never rewords.
- **One page.** At most `maxLines` lines (default 16, configurable). Over that, the
  least relevant atoms go first (on a tie, the one further down the resume). Role headers are
  never dropped, so the work history keeps no unexplained gaps.
- **Skills.** Master skills the job names come first (in the job's order), then the rest in
  resume order. A term an atom proves (its `how`) that the job asks for but the skills section
  lacks is **added**, citing that atom, and marked as added for the diff.
- **Not claimed.** Each requirement no atom's term meets yields the note
  `not claimed: <requirement> (no evidence)`. Nothing from it enters the resume.
- **Summary.** The deterministic tailor writes no summary line; the schema has a `summary` list
  (lines with citations) for the model route.
- **Locked facts.** A `TailoredResume` holds no employer, title, school, degree or date: sections
  name a role by id, and the renderer takes those facts from the master. Generation can't alter
  them, by construction.

### Provenance validator (TLR-002)
`validateTailoredResume(resume, master, { terms })` is plain code that blocks the resume, naming
the item and the problem (never its text), when:
- a summary or bullet line cites no atom, or cites an id not in the master;
- a section names a role not in the master, or a bullet cites an atom of another role (a project
  section may cite only role-less atoms);
- a line uses a number none of its cited atoms' resume lines state;
- a line names a term (any master skill, any atom `how` item, or a caller-supplied term such as
  the job's keywords) that none of its cited atoms names in its `what`, `how` or resume line;
- a skill isn't a master skill and isn't named by an atom it cites, or cites an unknown atom;
- an atom appears in more than one line of the experience sections (a duplicated claim).

Its known limits are the ones ADR-0004 lists (digit-token numbers, whole-word names); paraphrase
faithfulness for the model route is that route's eval.

### Render
`renderResumeText(resume, master)` gives an ATS-safe plain-text resume: single column, the fixed
headers `SUMMARY` (only when it has lines), `EXPERIENCE`, `PROJECTS` (only when present),
`EDUCATION`, `SKILLS`; each role as `Title, Employer · start – end` with `Present` only when
`isCurrent`; bullets as `- `. The PDF and DOCX renderers (TLR-005) will use the same structure.

### Diff (TLR-003)
`diffResume(master, resume)` lists, against the master:
- each atom as `kept`, `moved` (another position within its section, counting only atoms still
  in the resume) or `dropped`, with a separate `reworded` flag (its line's text differs from its
  resume line, or the line merges several atoms), so a line both moved and reworded shows both;
- each skill as `added` (not in the master), `removed` (a master skill left out) or `kept`.
`applySkillToggles(resume, remove)` returns the resume without the added skills Paul turned off
(the keep/remove toggles); master skills can't be removed this way, they are his record.

### Pre-send score (TLR-004)
`preSendScore({ resume, master, job, rendered, reparsed })` returns:
- **Title match:** `exact` when the rendered text names the job title as a whole phrase,
  `partial` when it shares a significant word (3+ letters, not a stop word), `none` otherwise,
  `unknown` when the job has no title.
- **Keyword coverage:** requirements and nice-to-haves together; one is covered when a term it
  names (master skills and atom `how` items) appears in the rendered text. Reported as
  `covered/total` (e.g. 19/22) with the missing ones listed.
- **ATS parse check:** compares `reparsed` (the text our own parser reads back from the rendered
  file) with `rendered`: the share of rendered words recovered (as a multiset, case and
  typography normalised) and every section header the render used. It passes at ≥ 95% words and
  all headers (the TLR-004 acceptance criterion). Until the PDF renderer exists the caller passes
  the text render read back through `fileToText`; the check itself doesn't change.

## Acceptance criteria
- [ ] A job that demands Kubernetes, which no atom names, gets a tailored resume that doesn't
      contain "Kubernetes" and the note `not claimed: Kubernetes (no evidence)` (TLR-002
      acceptance, test in `tailor.test.ts`).
- [ ] Inside a role, the atom naming the job's must-have comes before one naming nothing; roles
      keep resume order (test).
- [ ] With `maxLines` below the atom count, the least relevant atoms are dropped and every role
      header stays (test).
- [ ] A skill the job asks for that an atom's `how` proves but the skills section lacks is added,
      citing that atom; one no atom proves is not (test).
- [ ] The validator passes the tailor's own output, and blocks each case listed above with the
      item and problem (tests, one per rule).
- [ ] The diff reports kept, moved, dropped, reworded, added and removed (tests);
      `applySkillToggles` drops an added skill and refuses to drop a master skill (test).
- [ ] The pre-send score reports title match, `covered/total` with the missing list, and an ATS
      check that passes on the render read back from a `.txt` file and fails when a header or more
      than 5% of the words are lost (tests).
- [ ] `pnpm --filter @northstar/profile lint|typecheck|test` pass.

## Failure modes
No dependency is called: the functions are pure. Bad input (an atom id the master doesn't have, a
role id that doesn't exist) is reported by the validator, never thrown past it. An empty master
(no atoms) gives a resume with role headers and skills only, and every requirement not claimed.

## Observability
None in this slice: no agent action happens yet (nothing is stored, sent or called). The events
(`resume.tailored` with ids, counts, coverage and the validator's result, never resume text) and
the span arrive with the follow-up that stores a tailored version per application.

## Out of scope (follow-up issues, `agent-filed`, `Parent: #16`)
- The `resume-tailor` model route: a summary and wording that mirrors the job's terms where
  truthful (TLR-001), checked by this validator; off by default with hand-written fixtures until
  Paul records real ones.
- PDF and DOCX rendering from a template, the ATS re-parse of the rendered PDF, and storing each
  tailored version per application (TLR-004, TLR-005): needs a rendering dependency and a schema
  change.
- A `profile tailor <job-id>` command that reads the master and the job from the database, plus
  the `resume.tailored` event and span.
- Cover letters (TLR-006) aren't in #16.

## Open questions
- Inferred: 16 bullet lines as the one-page default. Paul's real page fits more or fewer
  depending on line length; the PDF renderer will measure the page instead.
- Inferred: keyword coverage counts requirements (as fit scoring does), not single words, so
  "19/22" means 19 of 22 requirements. A model-assisted keyword list can refine it later.
