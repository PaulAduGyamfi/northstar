# NS-111: Guided story interview → STAR story bank

Status: approved by Paul (2026-11-24; terminal interview, fixed script + two follow-ups, proposed competency list, one PR)
Requirements: CPG-003 (story bank), ADR-0004 (profile graph and provenance), NFR-AIQ-001/002/003,
OBS-001, RES-006. Feeds ANS-004 and OUT-004 later. GitHub issue #10.
Rules that apply: AGENTS.md (no fabrication, untrusted text is data, code decides, public repo:
synthetic fixtures only), `.claude/rules/llm.md`, `.claude/rules/db.md`, `.claude/rules/tests.md`,
ADR-0012, ADR-0013.

## Why
Resume bullets say *what* Paul did. Behavioral questions, "Describe a challenging project" answers
and outreach proof points need the *story*: the situation, what he was asked to do, what he did,
and how it turned out, told the way he tells it (CPG-003). ADR-0004 makes stories the second kind
of source material generators may cite, next to atoms. After this ticket, Paul runs a short
interview in his terminal. Northstar asks him about one atom at a time and drafts a STAR story
from his own answers. A deterministic check proves the story says nothing he didn't say, and the
story enters the bank only after he approves it.

## Scope (recommended; see open questions 1 and 2)
- A terminal interview (`profile interview`). There is no web app yet (`apps/web` arrives later),
  so the web chat is a follow-up.
- The questions are a fixed STAR script in code. The model adds at most two follow-up questions
  when the answers leave a part of the story thin.

## Behavior
**Schema (`packages/db`, migration 0009):** every row has `candidate_id`, and links go through
same-candidate composite keys like NS-110.
- `story_interview`: one session about one atom (`atom_id`). Its status is `open`, `drafted` or
  `abandoned`.
- `story_answer`: one question and Paul's answer, in order (`position`). These are Paul's own
  words: they stay in the local database and never go into events, spans, logs or fixtures.
- `story`:
  - `title`, `situation`, `task`, `action`, `result`;
  - `competencies`: 1–3 tags from a fixed list (open question 3), enforced by a CHECK;
  - `status`: `draft`, `approved` or `rejected`;
  - `prompt_version`, `model` (NFR-AIQ-003) and `approved_at`.
- `story_atom`: the atoms a story cites (at least one).

**An approved story is locked.** A trigger refuses any update or delete of an approved story,
including its status, and any change to the atoms it cites. Generators may cite a story, never
rewrite it (ADR-0004). Editing or retiring a story waits for a UI (Paul, 2026-11-24: keep the
strict lock).

**The interview (`packages/profile`):**
1. Paul runs `profile interview`. It picks the next atom from the current resume source that has no
   approved story, in resume order. `--atom <id>` picks one atom.
2. It shows the atom (what, role and source quote) and asks the script:
   - Situation: what was going on, and why did it matter?
   - Task: what were you responsible for?
   - Action: what did you do, step by step?
   - Result: what changed? Any numbers you can stand behind?
   - Anything else (optional; an empty answer skips it).

   Each answer is saved as soon as Paul gives it, so stopping halfway loses nothing. Running
   `profile interview` again resumes the open session.
3. **Route `story-draft`** on the NS-106 gateway. It takes the atom (id, what and quote) and Paul's
   answers, each in an `untrustedBlock`. It returns, as structured output:
   - `title`;
   - `situation`, `task`, `action` and `result`, each with its `text` and `quotes`, the verbatim
     excerpts of Paul's answers it rests on;
   - `atomIds` and `competencies`;
   - `followUps`, at most two questions for a part that is too thin to tell.

   The prompt asks it to keep Paul's wording and only trim and order it.
4. If the first draft has follow-ups, the CLI asks them, saves the answers and drafts once more.
   The second draft's follow-ups are ignored.
5. **Provenance check (NFR-AIQ-002), plain code.** It runs on every draft and rejects it if any of
   these holds:
   - a STAR part has no quote, or a quote isn't verbatim in Paul's answers (typography and
     whitespace normalised, the same way as NS-110);
   - a part's text uses a number that isn't in its quotes or in a cited atom's source quote;
   - an atom id isn't the interview's atom;
   - it cites no atom.

   A rejected draft isn't stored. The CLI lists the failures and offers to redraft or skip.
6. Paul sees the draft with its quotes and chooses `approve`, `redraft` or `skip`:
   - `approve` stores the story as approved, with its atom links;
   - `redraft` calls the route again;
   - `skip` marks the session abandoned and moves on to the next atom.
7. `profile stories` lists the approved stories and which competencies have no story yet.

**Events (OBS-001), ids and counts only, never text:** `story.interview_started`,
`story.answer_recorded` (position only), `story.drafted` (with the call record),
`story.approved`, `story.rejected` and `story.interview_abandoned`. Re-sending the same answer for
the same position is a no-op (RES-006).

**Eval set (`evals/story-draft`, NFR-AIQ-001):** about 8 synthetic cases, each one atom plus
scripted answers (invented people and companies):
- clean answers;
- answers with no numbers, which must give a result with no invented metric;
- a prompt-injection line inside an answer, which must be ignored;
- thin answers, which must produce follow-ups;
- a long, rambling answer that must be trimmed without inventing anything.

The grader runs the provenance validator on every case and checks the expected competencies and
whether follow-ups were asked. Paul records the fixtures once (`--record`, synthetic only).

**ADR-0004** gets a bullet on how stories are anchored to Paul's answers (it is still Proposed;
editing it asks Paul).

## Acceptance criteria
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0.
- [ ] DB tests (PGlite):
  - a story with no atom, a tag outside the list, or more than 3 tags is refused;
  - changing an approved story's text is refused;
  - a story can't cite another candidate's atom;
  - recording the same answer twice writes one row and one event.
- [ ] Validator tests:
  - a quote that isn't in the answers is rejected;
  - a number that isn't in the quotes or the atom is rejected;
  - a foreign atom id is rejected;
  - a part with no quote is rejected;
  - a clean draft passes;
  - curly quotes and line breaks don't cause false rejections.
- [ ] Interview tests (fake gateway, fake terminal, synthetic atoms):
  - the script asks five questions, saves each answer, and drafts;
  - follow-ups are asked once, then the CLI drafts again;
  - an interrupted session resumes at the next unanswered question;
  - approve stores the story and its atom links;
  - skip abandons the session and moves to the next atom;
  - a rejected draft writes no story.
- [ ] No answer or story text in events or CLI status lines (tests check the events and output).
- [ ] Prompt lock test covers `story-draft/v1.md`.
- [ ] `pnpm --filter evals eval story-draft` replays at or above `baseline.json` in CI.
- [ ] Paul runs `profile interview` on at least one real atom and approves a story he'd tell.
      That output stays local; only "done" goes in the PR.
- [ ] `checks` is green on the PR. The reviewer and security-reviewer find nothing critical (a
      prompt that reads Paul's free text).

## Failure modes
- **Claude API down or rate-limited:** `LlmTransportError`. The answers are already saved; the CLI
  says to run `profile interview` again later to resume.
- **Refusal, truncation or invalid output:** reported with the call record, and no story is
  written. Paul can redraft or skip.
- **Invented content:** the validator rejects the draft and lists the failures; nothing is stored.
- **Postgres down:** the CLI checks the connection before asking the first question, so Paul
  doesn't type answers that can't be saved.
- **Ctrl-C or a closed terminal:** every answer given so far is saved; the session stays `open`.
- **The atom's source is superseded by a re-import:** existing stories keep pointing at the old
  atom (rows stay for history). The picker only offers atoms from the current source.

## Observability
- The events above, with the story-draft call record (tokens, cost, prompt version, model).
- The gateway's `llm.call` span, plus `profile.interview` with the atom id, rounds, outcome and
  follow-up count.

## Out of scope
- The web chat (needs `apps/web`), a Temporal workflow, embeddings for stories.
- Editing, deleting or retiring an approved story (needs a UI and a new migration that allows it).
- Stories that span several atoms or roles (one atom per interview for now).
- Voice profile (ANS-007) and using stories in answers (ANS-004).
- Fully model-led interviewing beyond the two follow-ups.

## Open questions
1. **Interface.** Recommended: the terminal now, since there is no web app yet. A web chat comes
   with the UI tickets and reuses the same interview logic.
2. **Questions.** Recommended: a fixed script plus at most two model follow-ups, which is cheap,
   predictable and testable. Alternative: the model leads every turn, which costs more and is
   harder to eval.
3. **Competency list** (inferred from CPG-003's examples): `leadership`, `conflict`, `ambiguity`,
   `scale`, `failure`, `ownership`, `collaboration`, `technical-depth`, `customer-impact`,
   `learning`. Paul to confirm or edit.
4. **Paul's raw answers in the database.** They are his real words, kept in the local Postgres
   only (never committed, logged, evented or recorded as fixtures). Retention and delete-all come
   with NFR-SEC-005's export tooling.
5. **Effort.** Recommended: `medium` for `story-draft`; the eval decides if it needs `high`.
6. **Editing before approval.** Recommended: no free-text edit in the terminal; `redraft` or
   answer the follow-ups. Paul's edits (and ANS-008 learning from them) come with the UI.
7. **Recording the eval fixtures** needs Paul's API key and costs a few cents. The CI replay
   fails with `MissingFixture` until then. Recommended: Paul records before merge.
8. **Diff size.** About 1,200–1,500 lines with tests and eval cases, over AGENTS.md's ~300.
   Alternative: two PRs (schema and write paths first, then the route, validator and CLI).
