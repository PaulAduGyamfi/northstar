# NS-141: Answer factual questions from profile settings

Status: accepted (autonomous lane, ADR-0016)
Requirements: ANS-001 (factual questions answered from profile settings), ANS-002
Rules that apply: ADR-0004, ADR-0012, ADR-0016, `.claude/rules/db.md`, `.claude/rules/tests.md`
Parent: #59

## Why
NS-118 classifies a form question as factual (work authorization, sponsorship, years with a
skill, location, start date, salary …) and maps it to a canonical question with a `factualField`.
Nothing stores Paul's answers to those, so every factual question still needs him.

## Behavior
1. **Settings store** (`packages/db`, `profile_setting`, one migration): one row per change,
   append-only; the current value of a field (and qualifier) is its newest row. Every row has a
   `candidate_id`. A field is one of `FACTUAL_FIELDS`. Three fields are keyed by a qualifier
   taken from the question's slot, because one value for all would be invented:
   `years_of_experience` per skill, `work_authorization` per country, `previously_employed` per
   company. No default for a qualifier with no stored value. Setting the value it already has
   stores nothing.
2. **Typed values** (plain code, `packages/profile/src/factual.ts`): yes/no fields
   (`work_authorization`, `needs_sponsorship`, `willing_to_relocate`, `previously_employed`), a
   whole number of years, an ISO date (`earliest_start_date`), `remote|hybrid|onsite`, an https
   URL (`linkedin_url`, `portfolio_url`), and short text for the rest. A bad value is refused.
3. **Answering** (`answerFactual(question, settings)`, plain code, no model): match the question
   (`classifyQuestion`); if it is factual, find its setting (for a keyed field, the stored
   qualifier the question names as a whole word, case-insensitive) and answer in the question's
   own form: "Yes"/"No" for a yes/no question, the number for "how many", the value otherwise.
   Anything else is unanswered with a reason (`not_factual`, `no_setting`, `no_qualifier`,
   `form_mismatch`). Every answer carries the canonical question and the setting used, for Paul
   to see, and is marked for review until a labelled set shows the matcher is reliable.
4. **Events:** `profile.setting_set` (field and whether it has a qualifier; never the value or the
   qualifier) and `answer.factual_used` (canonical id, kind, field, confidence; never the form's
   question text or the setting's value).
5. **CLI** (Paul only): `profile settings set <field> <value> [--for <qualifier>]`,
   `profile settings show`, `profile answer "<question>"` (prints the answer, the canonical
   question and the setting used, and records `answer.factual_used`).

## Acceptance criteria
- [ ] A stored yes/no setting answers "Are you legally authorized to work in Canada?" with "Yes"
      only when Canada is the stored qualifier; another country is `no_qualifier`.
- [ ] "How many years of experience do you have with Go?" answers the stored Go number; a skill
      with no value is `no_qualifier`, never a default.
- [ ] A narrative question is `not_factual`; a factual field with no setting is `no_setting`; a
      yes/no question over a text value is `form_mismatch`.
- [ ] Bad values are refused (a non-https URL, a negative number, a bad date, an unknown field).
- [ ] Settings are append-only, newest wins, setting the same value is a no-op, per candidate.
- [ ] Events carry no value, qualifier or question text.

## Failure modes
None outbound. A question the matcher gets wrong is visible: every answer shows the canonical
question and the setting used, and is marked for review.

## Observability
Events above; `profile.setting_set` and `answer.factual_used` feed lines from their reasons.

## Out of scope
- Filling forms with these answers (the Apply Gateway's package assembly, NS-161).
- A settings page in the app.
