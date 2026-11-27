# NS-231 slice 4: independent-work counts in `resume.tailored`

Status: in progress (autonomous lane, ADR-0016)
Requirements: DX-010, OBS-001 (every action in the feed, with counts)
Rules that apply: `.claude/rules/db.md` (tailored resumes: `resume.tailored` carries ids, counts
and flags only), `.claude/rules/tests.md`.
Issue #245. Slices 1–3: #296, #298, #304. Item from slice 1's review.

## Why
Since slice 1 every tailored resume carries Paul's independent-work section, but the
`resume.tailored` event and its summary don't say so: the feed and the run inspector can't tell a
resume with the section from one without it, or how much of it fit the page.

## Behavior
- `TailorSummary` (`packages/db`) gains `workEntries` and `workLines`: how many independent-work
  entries and lines the stored version carries (0 and 0 without a section).
- `summarize` (`packages/profile`, `tailor/run.ts`) counts them from `resume.independentWork`.
- They go into the event's payload with the other counts. Never a title, line or link.
- The event's `reason` sentence is unchanged.

## Acceptance criteria
- [ ] A tailored resume with a section reports its entry and line counts in `resume.tailored`.
- [ ] One without a section reports 0 and 0.
- [ ] No title, line or link appears in the payload.
- [ ] `pnpm turbo run lint typecheck test build` passes in `packages/db` and `packages/profile`.

## Out of scope
- The database check for invisible characters (needs a migration; agent 1 holds the lane).
- The thesis surfaces; requiring every stored entry.
