# NS-192 slice 3: the pre-fill's event and the extension's fill logic

Status: in progress (autonomous lane, ADR-0016)
Requirements: APPLY-006, ACC-007 · ADR-0029 (Accepted, option 2), ADR-0003, ADR-0019
Rules that apply: `.claude/rules/extension.md`, `.claude/rules/gateways.md`, `.claude/rules/db.md`,
`.claude/rules/tests.md`.
Issue #161 (Parent #20). Slices 1–2: #318, #328.

## Why
Slice 2 serves one open handoff's approved package to the extension, with Paul's one-time grant.
ADR-0029 also requires two things whatever the hand-off looks like:
- the extension fills only the fields the ATS adapter maps, only when the tab's host is one of that
  adapter's hosts and matches the apply URL, and never presses submit;
- a pre-fill writes `handoff.prefilled` (ids, ATS, field count; never values).

How the grant reaches the extension ("the deep link Paul clicks") isn't specified. Each way to do
it changes the extension's permissions or departs from the ADR's wording, so that part is Paul's
call (a `needs:paul` issue). This slice builds what every option shares.

## Behavior
- **`handoff.prefilled`.** `POST /handoffs/package` writes it after the read passes and before it
  answers, through `recordHandoffPrefill` (`packages/db`, `handoff-write.ts`):
  - aggregate `apply_handoff:<id>`, actor `user` (Paul's click issued the grant);
  - payload: `handoffId`, `applicationId`, `ats` and `fieldCount` (the package's own fields);
  - key `apply_handoff:<id>:prefilled:<grant key>`, where the grant key is the first 16 hex
    characters of the grant's SHA-256. Each grant is used once, so a retry of the same serve stores
    one event.
  - If the event can't be written, nothing is served (`503 prefill_unrecorded`). The grant is
    already used, so Paul clicks again.
  - Feed: "Pre-filled a Greenhouse form for you to finish".
- **`prefillPlan(pkg, tabUrl)`** (`apps/extension/src/prefill.ts`, plain code) gives the fills, or
  a refusal code:
  - `not_https`: the tab isn't https, or has a port or credentials;
  - `wrong_host`: the tab's host isn't one of the ATS's own hosts (a fixed table mirroring the
    gateway adapters: Greenhouse `boards.greenhouse.io`, `job-boards.greenhouse.io`; Lever
    `jobs.lever.co`; Ashby `jobs.ashbyhq.com`; SmartRecruiters `jobs.smartrecruiters.com`);
  - `wrong_page`: the tab's host and path aren't the apply URL's.

  The fills are the adapter's standard contact fields (by the same names the gateway adapters use;
  no phone field when there is no phone), then the package's own fields. A package field that
  reuses a standard field's name is refused (`form_changed`), as the gateway's `mapPackage` does.
- **`fillForm(fills)`** runs in the page (self-contained, so Chrome can serialise it). For each fill
  it finds the elements with that exact `name` and sets the value only on a visible, enabled
  `input` (not file, hidden, submit, button, image or reset), `textarea` or `select` whose options
  include the value. A checkbox or radio is checked only when its value is one of the values. It
  fires `input` and `change` events and never clicks, submits or focuses a button. It returns
  counts (filled, skipped), never values.
- **`packageRequest(settings, handoffId, grant)`** builds the `POST /handoffs/package` request
  with the extension's token and a 30-second time limit (RES-005). `prefillMessage(status, body)`
  says what happened in plain words.

Nothing calls `prefillPlan`, `fillForm` or `packageRequest` yet: the popup wiring waits on the
hand-off decision.

## Acceptance criteria
- [ ] A served package writes `handoff.prefilled` with ids, ATS and a count, and no value. The
      same grant key stores one event, and a failed write serves nothing.
- [ ] The feed line has no field value.
- [ ] `prefillPlan` refuses an http tab, another host, a lookalike host and another page, and
      fills only standard fields and the package's own field names.
- [ ] `fillForm` never clicks or submits, and skips file, hidden, disabled and unknown fields and
      values a select doesn't offer (tests on fake elements).
- [ ] The manifest is unchanged (its test still pins the same permissions).
- [ ] `pnpm turbo run lint typecheck test build` passes in every touched package.

## Out of scope
- The hand-off from the card to the extension, and the popup wiring (`needs:paul`).
- Files (the resume and cover letter): the package serves none.
