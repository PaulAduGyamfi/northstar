# NS-255: the form driver refuses forms it can't read or submit safely

Status: in progress (autonomous lane, ADR-0016). Assigned by the orchestrator. Refuse-only scope.
Issue: #353 (agent-filed, Parent #76). Needs the security-reviewer.
Requirements: APPLY-002, APPLY-008 · ADR-0002, ADR-0003, ADR-0028
Rules that apply: `.claude/rules/gateways.md`, `.claude/rules/tests.md`

## Why
Recorded Greenhouse and Lever forms (NS-142 slice 2, `src/apply/test/recorded.ts`) show shapes
the driver can't handle safely:
- fields with an id and no name;
- react-select comboboxes in place of native selects;
- a visible "Submit" that is `type="button"`, while the only `type="submit"` is a hidden
  hCaptcha button.

Nothing submits today (no worker, #230), but these must be refused before the first real
submission.

## Behavior (refuse, never handle)
- `collectPage` also reports, per form: how many answerable controls have no name, how many are
  comboboxes (`role="combobox"`), and each submit candidate (the same set `SUBMIT_SELECTOR`
  matches), with whether it is hidden and whether it is tied to a CAPTCHA. Hidden means a
  `hidden` attribute, `aria-hidden="true"`, a hiding class (`hidden`, `visually-hidden`,
  `sr-only`, `d-none`) or an inline style with `display:none` / `visibility:hidden`. Tied to a
  CAPTCHA means "captcha" in its id, class or `data-callback`, or a `data-sitekey`.
  `checkCollected` checks these too.
- `formProblem` (plain code) gives the first problem of a form, or null:
  - `unnamed_fields`;
  - `combobox`;
  - `no_submit` (none, including a `type="button"`-only form);
  - `several_submits`;
  - `hidden_submit`;
  - `captcha_submit`.
- `open` treats a picked form with a problem as no form. The gateway then hands off with
  `form_changed` before anything is typed or pressed, and the snapshot and screenshot are kept.
  The problem code goes on the driver's span, never page text.
- An `h-captcha` widget counts as a CAPTCHA even when marked invisible: the conservative reading
  of ADR-0003. Paul may relax it later. Invisible reCAPTCHA is unchanged.
- Submit candidates come from the form's descendants (`getElementsByTagName`), where the click
  locator searches, not `form.elements` (a `form="…"` attribute could make them differ).
- `fillAndSubmit`'s own "exactly one submit button" check stays as a second guard.
- Not in this PR: re-reading the form right before the click. It changes two existing tests'
  exact action lists, an assertion change, so it waits for Paul (#359, NS-256).
- No new `NeedsHumanReason`: a dedicated code would need a migration (the database CHECKs the
  list). `form_changed` it is, recorded under "Decisions made without Paul".

## Acceptance criteria
- [x] The recorded Greenhouse form, and a form like it with names but a combobox, open as no form.
- [x] A form whose only submit is hidden, tied to a CAPTCHA, or missing (`type="button"` only)
      opens as no form, and nothing is typed.
- [x] An invisible-marked `h-captcha` is a `captcha` challenge.
- [x] The synthetic Greenhouse, Lever and Ashby pages still open as forms (no regression).
- [x] lint, typecheck, test and build green for `@northstar/gateways`.

## Out of scope
- Reading fields by id, choosing react-select options, or pressing a `type="button"` submit.
  Each needs its own spec.
- A dedicated reason code (needs a migration).
