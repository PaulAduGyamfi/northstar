# NS-256: re-read the form right before the driver presses submit

Status: in progress (autonomous lane, ADR-0016), under the decision recorded on #359
(comment 7217126550: the orchestrator, under Paul's delegation of 2026-11-27).
Issue: #359 (agent-filed, Parent #353). Needs the security-reviewer.
Requirements: APPLY-002, APPLY-008 · ADR-0003, ADR-0028

## Why
NS-255 (#360) refuses unsafe form shapes at `open`. A page's own script can change the form
afterwards: it can add a combobox or a name-less required field, or turn the single submit into a
CAPTCHA-tied one. `fillAndSubmit` re-checked only the form count and the number of submit buttons.

## Behavior
- Just before counting and clicking the submit, `fillAndSubmit` re-runs
  `checkCollected(await page.evaluate(collectPage, null))`. It throws a `DriverError`, before
  pressing anything, if:
  - a challenge now shows (`challengeOf`);
  - the number of forms changed;
  - `formProblem` of the picked form is no longer null (the code goes on the span as
    `northstar.apply.form_problem`).
- The gateway already turns a `DriverError` into a `driver_error` handoff.

## The assertion change (approved on #359)
Two tests in `driver.test.ts` assert the driver's exact action list:
- "fills each field, uploads the files, presses the one submit button and returns the next page";
- "checks a radio and a checkbox group by label in the page".

Each gains the one `evaluate collectPage` step before the submit's `count` and `click`. Every
existing step stays.

## Acceptance criteria
- [ ] A form that gains a combobox after `open` is refused with nothing pressed.
- [ ] A form whose single submit becomes CAPTCHA-tied after `open` is refused with nothing
      pressed.
- [ ] A challenge that appears after `open` is refused with nothing pressed.
- [ ] The two existing tests change only by the added step.
- [ ] lint, typecheck, test and build green for `@northstar/gateways`.
