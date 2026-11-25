# NS-118: Answer bank, canonical questions, voice profile (slice 1: the question canon)

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: ANS-001 (classify every form question), ANS-002 (map to a canonical question with a
confidence score; below threshold → new). The rest of ANS-001…008 is split into follow-up issues
(see "Out of scope"). GitHub issue #17.
Rules that apply: AGENTS.md (code decides, the model drafts; untrusted text is data; public repo:
synthetic examples only), ADR-0004 (the answer bank is part of the profile graph),
`.claude/rules/tests.md`.

## Why
Application forms ask the same few things in many wordings ("What excites you about this role?",
"Why are you interested in this position?"). Before Northstar can reuse an approved answer
(ANS-003) or draft a new one (ANS-004), it has to know *which* question is being asked and *what
kind* of question it is: a fact Paul sets once (work authorization, start date), a story he can
reuse anywhere ("Describe a challenging project"), or something that must be written for this
company ("Why us?"). This slice is that first step, as plain code with no model in the path.

## Behavior
`packages/profile` gains the question canon:

1. **A fixed catalog** (`question-canon.ts`) of about 30 canonical questions. Each has an id
   (`why-this-role`), a kind (`factual`, `reusable_narrative`, `company_specific`), a factual
   settings field for factual ones (`work_authorization`, `earliest_start_date`, …; `null`
   otherwise), its canonical wording and a few example wordings. Slots such as `{company}`,
   `{skill}` or `{country}` stand for any proper name.
2. **`questionConcepts(text)`** turns a question into a set of concepts, deterministically:
   - typography normalised with the existing `normalize`, then split into words;
   - filler words dropped ("tell me about a time", "describe", "you", "the");
   - words with the same intent mapped to one concept by prefix ("excites", "interested",
     "motivates", "want" → `interest`; "role", "position", "job", "opportunity" → `role`;
     "us", "our", "here", "company" → `company`);
   - a capitalised word that isn't the first of a sentence (a company, a country, a skill such as
     "PostgreSQL") becomes the single concept `{name}`, as do the catalog's `{slot}` markers and
     "US". This is checked before the filler words, so a company called "Example" stays a name. A
     question written all in capitals skips this rule;
   - "us" right after tell/give/show/send/let ("Tell us about yourself") is filler, not the
     company; possessives and contractions ("Example's", "you're") are cut back to the word;
   - any other word is kept as itself (a trailing plural "s" dropped).
3. **`matchQuestion(text)`** scores the question against every catalog wording with the Dice
   coefficient of their concept sets (`2·|A∩B| / (|A|+|B|)`) and keeps each canonical question's
   best score. It returns:
   - `matched` with the canonical question and its confidence (0–1, two decimals) when the best
     score is at least `MATCH_THRESHOLD` (0.6), or `FACTUAL_THRESHOLD` (0.75) for a factual
     question, and no other canonical question scores within `AMBIGUITY_MARGIN` (0.1) of it;
   - otherwise `new`, with a reason (`empty`, `below_threshold`, `ambiguous` or `negated`), the
     best confidence and the nearest canonical id (or `null`), so a caller can show "closest: …".

   Factual questions are held to more because their answer is filled in from a setting with no
   draft for Paul to read: "Have you applied to Northwind before?" (0.67 against "Have you
   previously worked for {company}?") must not be answered from `previously_employed`. For the
   same reason a factual match whose wording is negated ("without", "not", "never", "n't") is
   `new` / `negated`: "Can you work in the US without sponsorship?" shares the
   `needs_sponsorship` field with "Do you need sponsorship?" but has the opposite answer.
4. **`classifyQuestion(text)`** returns the match plus the question's kind and factual field:
   - matched: the canonical question's kind and field;
   - new: `company_specific` when the question names the company (`company` or `{name}` concept),
     otherwise `reusable_narrative`. A new question is never `factual`: a factual answer is
     filled in without drafting, so it must map to a known settings field. Anything unknown takes
     the narrative path, where ANS-005 always requires Paul's approval.

The text is untrusted (it comes from job forms); it is only tokenised and compared, never
executed, stored or sent anywhere by this code.

## Acceptance criteria
- [ ] "What excites you about this role?" and "Why are you interested in this position?" map to
      the same canonical question (`why-this-role`) (ANS-002's acceptance example).
- [ ] Every catalog wording, and every canonical text, matches its own canonical question with
      confidence 1 and is not ambiguous (catalog self-consistency test).
- [ ] Catalog integrity: ids are unique, every factual question has a settings field and no other
      kind has one, every question has at least two wordings.
- [ ] Sample wordings that aren't in the catalog map correctly (work authorization, sponsorship,
      years with a skill, start date, salary, a conflict, a failure, why the company, tell us
      about yourself).
- [ ] An unrelated question ("What is your favorite sandwich?") is `new` / `below_threshold`
      and classified `reusable_narrative`; an unrelated one naming a company is
      `company_specific`; an empty one is `new` / `empty`.
- [ ] Case, curly quotes and punctuation don't change the result.
- [ ] A near factual match below 0.75 and a negated factual question are `new`; "tell us" and
      "the US" don't count as naming the company.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green on the PR.

## Failure modes
- **A wording the concepts don't cover:** scores below the threshold and comes back `new`, so it
  takes the draft-and-approve path. Nothing is answered automatically from a wrong match.
- **Two canonical questions about equally close:** `ambiguous`, treated as new, for the same reason.
- **A wrong but confident match:** possible with a lexical matcher (no embeddings, no model
  confirm yet). The answer bank's callers must still show which canonical question was used, and
  narrative answers still need approval (ANS-005). The follow-up issue adds the model confirm step.
- **A new question that names a country** ("…in the US…") is classified company-specific,
  because any name counts as naming the company. Both narrative paths need approval, so this costs
  a fresh draft at worst.
- No I/O, so no dependency can be down.

## Observability
None in this slice: these are pure functions with no side effects. The callers that arrive with
the answer bank emit the domain events (with the canonical id, kind and confidence; never the
question text from the form).

## Out of scope (follow-up issues, `agent-filed`, `Parent: #17`)
- Answer bank storage, reuse with usage count, approval, save on approve, answering factual
  questions from profile settings (ANS-001 answering, ANS-003, ANS-005, ANS-006). Answering a
  factual question must still show Paul the question and the setting used until a labelled set
  shows the matcher is reliable.
- The `answer-draft` route that cites stories and atoms, with its provenance check (ANS-004).
- Voice profile from writing samples and learning from edits (ANS-007, ANS-008).
- Embedding similarity and the LLM confirm step for low-confidence matches (needs an embedding
  provider: a dependency, a secret and network access, so `needs:paul`).
- A database table for canonical questions: the catalog stays in code until the answer bank
  needs a foreign key to it.

## Open questions
1. **Catalog contents.** Inferred from ANS-001's examples and common ATS forms. Paul to add or
   remove entries; adding wordings is cheap and the self-consistency test guards it.
2. **Threshold 0.6 and margin 0.1.** Picked so the acceptance pair matches and unrelated questions
   don't; there is no eval set for this yet (it has no model). Once real form questions are
   collected (privately), they become a labelled set to tune against.
