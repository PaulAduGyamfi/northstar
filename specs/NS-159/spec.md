# NS-159: Resume audit with line-level suggestions

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: AUD-001 (score the master resume on impact density, verb strength, ATS
parseability, length, keyword coverage against the target roles and consistency, with line-level
suggestions), AUD-002 (Paul accepts or rejects each suggestion; accepted changes update the master
and its atoms). AUD-003's rule is kept: missing metrics become questions, never invented numbers.
GitHub issue #110 (Paul's).
Rules that apply: ADR-0004 (no fabrication; locked facts never change), CPG-004, AGENTS.md (code
decides), `.claude/rules/tests.md`.

## Why
Paul's master resume feeds every tailored version. Weak spots (bullets with no result, "Helped
with…" openers, present tense in an old role, a missing date, a keyword his target roles want but
he never wrote down) are cheaper to fix once in the master than in every application.

## Behavior
All in `packages/profile/src/audit/`, plain code, no model, no database.
1. **`auditResume(master, targets)`** (`audit.ts`). `targets` are terms from the roles Paul is
   aiming for (for example, the search preferences' titles and the requirements of jobs he
   saved). It returns a score from 0 to 100 for each dimension and a list of suggestions, each
   tied to an atom id (or to a role or a target term):
   - **Impact density:** the share of bullets with a measured result (digits or a number word).
     A bullet with none gets `missing_metric`, a question for Paul ("What changed, by how
     much?"). It never proposes a number (AUD-003).
   - **Verb strength:** the share of bullets that open with an action verb, not a weak opener
     ("helped", "worked on", "responsible for", "assisted", "participated", "involved in",
     "tasked with"). `weak_opener` names the opener found.
   - **ATS parseability:** the master rendered to PDF (`renderResumePdf`, NS-145) and read back
     (`pdfToText`) gives the share of words recovered (`atsParseCheck`). Unencodable characters
     and missing headers lower it; `ats` names how many words were lost.
   - **Length:** 100 when the full master fits one page, minus 25 per extra page; bullets over 200
     characters get `long_line`.
   - **Keyword coverage:** the share of target terms the master names anywhere (atoms, skills).
     A missing one gets `missing_keyword`, worded "add it only if you have done it".
   - **Consistency:** a bullet in a past role that opens in the present tense ("Build",
     "Manages", "Leading") gets `tense`. A role with no start date, or a past role with no end
     date, gets `missing_date`, which points Paul to his official record (`profile facts`),
     because dates are locked facts (CPG-004).
   - An overall score, the mean of the six.
2. **`applySuggestion(master, suggestion, newLine)`** (`apply.ts`, AUD-002) returns a new master
   in which only the suggested atom's resume line is Paul's new text. It refuses:
   - a suggestion that isn't about an atom line (roles, dates and keywords are not edited here);
   - an empty or multi-line text;
   - a line that names an employer, title or date from another role.

   Nothing else changes. Storing the result is the caller's job.

## Acceptance criteria
- [ ] A synthetic master gives the expected scores and suggestions for each dimension (profile
      tests): a bullet with no number, a "Helped…" bullet, a present-tense bullet in a past role,
      a missing date, a missing target keyword, an over-long line, and a clean master scoring 100
      where it should.
- [ ] No suggestion contains a number that isn't in the master (tested over all suggestions).
- [ ] `applySuggestion` changes only its line (the rest of the master is deep-equal), and refuses
      the cases above.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **A verb the lists don't know** is scored as an action verb, and an unknown tense passes. The
  lists err toward fewer suggestions, not wrong ones.
- No I/O beyond rendering in memory.

## Out of scope (follow-up issue)
- Storing the audit and Paul's accept/reject decisions, and the atoms update in `packages/db`.
  Another agent is changing `packages/db` migrations.
- A `profile audit` command. It would change the CLI's usage line, which `cli.test.ts` asserts
  exactly.
- Model-written wording suggestions (they would need a route and an eval).
