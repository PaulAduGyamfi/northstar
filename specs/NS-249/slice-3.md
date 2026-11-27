# NS-249 slice 3: the Gate checks each banked answer's question against the form label

Status: built (autonomous lane, ADR-0016). Assigned by the orchestrator.
Issue: #297 item 2, second half (parent #195). Slice 2 (#419) moved the canon and matcher to
`packages/domain`. Decision on #297 (2026-11-27, delegated by Paul): add the Gate check and the
`bank_exact` / `bank_high_confidence` check.
Requirements: ANS-002, ANS-003, APR-004, APPLY-004 · ADR-0002, ADR-0017
Rules that apply: `.claude/rules/db.md`, `.claude/rules/tests.md`

## Why
The Gate verifies that a claimed field holds Paul's approved banked text, but which question that
answer belongs to, and whether the match is exact or high confidence, are still the producer's
word. A wrong claim could put Paul's approved answer on an unrelated question and count it as
reuse, which can auto-approve a package.

## Behavior
- `labelReuse(label, canonicalId, company)` (`packages/domain`, `question-reuse.ts`): what an answer
  banked for `canonicalId` earns on a field with this label. `new` unless code's own match of the
  label (`matchQuestion`) is that same canonical question, a narrative one (not factual), and the
  label isn't negated (`isNegatedQuestion`). Otherwise `bank_exact` when the label is the canonical
  wording or one of its examples (company filled in, `isExactWording`), `bank_high_confidence` at
  `REUSE_HIGH_CONFIDENCE` (0.8) or above, else `new`. `weakerReuse` keeps the weaker of two.
- `requestPackageApproval` (`packages/db`): a claim that passes the text check now counts as
  `weakerReuse(claim.source, labelReuse(storedLabel, bankAnswer.canonicalId, company))`. The label
  comes from the stored form, never from the producer.
- `assemblePackage` (`packages/pipeline`) uses the same `isExactWording` and
  `REUSE_HIGH_CONFIDENCE`, so the producer's and the Gate's readings come from one rule.
- From the security review: a wording with `{company}` counts as exact only for a plain short
  company name (`isSafeCompany`, as the answer's own fill), so an employer's "company" can't hide an
  extra ask. This makes the producer stricter too: such a field is no longer `bank_exact`. And a
  label holding invisible formatting characters, modifier letters (U+02B0–02FF) or Greek or Cyrillic
  letters never earns reuse at the Gate (lookalikes could hide a "not"); it goes to Paul.

## Acceptance criteria
- [x] A claim on a label that asks another question, is negated, or matches nothing counts as
      `new`; one on the answer's own wording keeps `bank_exact` (PGlite tests).
- [x] A producer's claim never counts above the Gate's reading, nor above its own (existing test:
      an exact label with a `bank_high_confidence` claim stays high).
- [x] The shared rule is tested in `packages/domain`; existing Gate and pipeline tests unchanged.
- [x] An unsafe company name never makes wording exact (domain, Gate and pipeline tests), and a
      label with lookalike or invisible characters never earns reuse (domain tests).
- [x] lint, typecheck, test and build green for domain and every package that imports it; docs.

## Decisions made without Paul (ADR-0016)
- The security review's two fixes above. A label with a Greek or Cyrillic company name never
  earns reuse; it only goes to Paul. The producer doesn't apply the disguise check yet (the Gate
  does), so it may still draft an answer for such a label: a follow-up.
- The Gate keeps the weaker of the producer's and its own reading, rather than its own alone: a
  producer that knows less (a model's pick, which it marks `new`) is never upgraded.
