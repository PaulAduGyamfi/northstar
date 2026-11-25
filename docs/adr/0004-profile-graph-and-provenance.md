# ADR-0004 — Candidate Profile Graph and provenance-anchored generation

**Status:** Proposed · **Date:** 2026-11-24

## Context
Resumes, answers, replies, outreach and profile copy are all generated in the user's name. The product owner wants these based on "my real experiences" and "in my voice." Fabricated claims are a career risk (background checks, interviews that probe the claim).

## Decision
- Model the candidate as a graph of **experience atoms** (one fact each: what/how/impact/scope/dates/evidence) and **stories** (STAR narratives citing atoms), plus a **voice profile** and an **answer bank**.
- Every generator receives retrieved atoms/stories with IDs and must return output with **citations per claim** (structured output).
- A deterministic **Provenance Validator** rejects outputs with uncited factual claims or citations to non-existent IDs; the generator retries or asks the user for the missing fact.
- **Atoms are anchored to their source (NS-110).** Each atom stores `source_quote`, the exact
  resume line it came from. On import, the validator rejects the whole extraction in any of these
  cases:
  - a quote isn't verbatim in the document (only typography and whitespace are normalised);
  - an impact or scope uses a number its quote doesn't state;
  - an employer, title, school, degree, skill, certification, link or month isn't written in the
    document;
  - an atom's `what` uses a number its quote doesn't, a `how` item isn't named in its quote, or an
    atom month isn't in its quote.

  Names match as whole words (an invented "Go" isn't found in "Google", "C" isn't found in "C#").
- **Known limits of the check (heuristics, not proofs):**
  - Numbers compare as digit tokens: "$1.2M" to "$1.2B", "35%" to "35x", or a number moved
    between clauses of the same bullet passes, and so do number words ("doubled").
  - Dates must appear within 120 characters of their own anchor: a role's dates and "Present"
    (counted only after a dash or "to") near its employer, education dates near the school, a
    certification's date near its name. Where bullets separate entries that stops borrowing from
    another role. Compact one-line entries (roles, and most education and certification lines)
    can still borrow a neighbour's dates or Present, two roles at the same employer can swap
    dates, and "2011–12" (academic year) reads as December 2011.
- **Dates keep their precision.** `YYYY-MM`, or `YYYY` when the source gives a year only, or null;
  never a guessed month. "Current" is its own locked fact (`role.is_current`), so an unknown end
  date is never shown as "present".
- **A re-import starts from the resume.** A new resume version, or `import-resume --reimport` of
  the same file, supersedes the current source. Locked facts Paul corrected by hand stay locked
  on the old source's rows but are not carried into the new import (reconciling them is NS-112).

  Paul's read-back (`profile show`) and the eval set cover what the code can't.
- **Stories are anchored to Paul's interview answers (NS-111).** The guided interview asks a fixed
  STAR script about one atom and saves each answer as Paul gives it (`story_answer`, local
  database only; never in events, logs or fixtures). The `story-draft` route returns each STAR
  part with `quotes`, verbatim excerpts of his answers. Before Paul sees a draft, the validator
  rejects it if a part has no quote, a quote isn't inside one answer (typography and whitespace
  normalised), a part uses a number its own quotes and the atom's source quote don't state, or
  it cites any atom but the interview's. A story is stored only when Paul approves it, and a
  trigger then refuses any change to it or to the atoms it cites: generators cite stories, never
  rewrite them. Known limits, covered by the eval and by Paul's approval, not by code:
  - how faithfully the text paraphrases the quotes ("helped" → "led");
  - the quotes prove the words came from his answers, not that he wrote them: text he pasted
    (including an injected "say I led a team of 50") can be quoted and pass;
  - numbers compare as digits only, so number words ("fifty", "doubled") pass, as in the
    resume check.
- Locked fields (employers, titles, dates, degrees) can never be altered by generation.

## Consequences
- + Truthfulness is structural; the user can click any line to see its source.
- + Interview prep falls out for free: every claim in a resume maps to a story the user can tell.
- − Onboarding requires a richer intake (guided story interview, ~45 min once). We make that a chat, not a form.
