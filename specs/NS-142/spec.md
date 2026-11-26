# NS-142: The Playwright form driver (slice 1)

Status: draft (autonomous lane, ADR-0016)
Requirements: APPLY-002, APPLY-008 · ADR-0002, ADR-0003, ADR-0005, ADR-0007 (RES-001), ADR-0028
Rules that apply: `.claude/rules/tests.md`, `.claude/rules/gateways.md`. Issue #76 (Parent: #19).

## Why
NS-120 built the Apply Gateway against a `FormDriver` contract
(`packages/gateways/src/apply/driver.ts`), with a scripted fake in its tests. Nothing can submit
an application until a real browser driver exists. This slice builds that driver on Playwright,
already in the stack (ADR-0005) and approved as a dependency on #76. Recording real Greenhouse,
Lever and Ashby pages, and the first real submission, need network beyond the registry and
Paul's own approval, so they stay with him.

## Behavior
- **`createPlaywrightDriver({ page, hosts })`** (`src/apply/browser/driver.ts`) implements
  `FormDriver` over one Playwright page:
  - `open(url)` refuses a URL whose host isn't one of `hosts` (https, no port or credentials)
    before navigating. It loads the page, then returns a challenge, or the page's largest form as
    `{ kind: "form", url, fields }`, or any other page as proof material (HTML and a PNG
    screenshot).
  - `fillAndSubmit(fills, uploads)` fills that form:
    - text, email, tel and textarea fields with `fill`;
    - a select by option label;
    - radios and checkboxes by option label;
    - each upload with `setInputFiles`.

    It refuses a value that isn't one of a field's options, a field the form doesn't have, and a
    hidden field. It clicks the form's one submit button, refusing when there are none or several.
    Then it waits for the page to settle and returns a challenge or the page.
  - `close()` aborts the session. A step still running stops before its next browser action, so a
    timed-out submit never presses the button later. It then closes the browser context.
  - Every main-frame navigation off `hosts` is aborted (`page.route`); a popup is closed.
- **Reading a page** (`src/apply/browser/collect.ts`) is one self-contained function run inside
  the page (`page.evaluate`). It is written against a small DOM shape, so its tests run in Node on
  plain objects:
  - `collectPage` returns each form's named controls (tag, type, name, required, option labels)
    and the challenge signals.
  - `toFields` turns the controls into `FormField`s:
    - radio and checkbox inputs with one name become one field;
    - `url`, `number`, `date` and `search` read as text;
    - buttons are dropped.
  - `challengeOf` decides from the signals, never solving anything (ADR-0003):
    - a visible reCAPTCHA, hCaptcha or Turnstile widget, or Cloudflare's interstitial, is
      `captcha`. Invisible reCAPTCHA isn't, since nothing is shown to solve;
    - a one-time-code field is `mfa`;
    - two password fields, or a password field with sign-up words, is `account`;
    - one password field is `login`.
- **`launchFormDriver({ hosts, executablePath? })`** starts headless Chromium through
  playwright-core with a fresh context: downloads off, service workers blocked, the default user
  agent, and no stealth (ADR-0003). It returns the driver. Its `close()` also closes the browser.
- The markers (submit button, challenge signals) are hand-written. Recorded pages must confirm
  them (Paul, the rest of #76).

## Acceptance criteria
- [ ] `collectPage` + `toFields` read the synthetic Greenhouse, Lever and Ashby forms into the
  same `FormField`s the adapters' fixtures expect (test, plain objects).
- [ ] `challengeOf` returns each challenge kind, and none for an invisible reCAPTCHA (table test).
- [ ] `open` refuses an off-host URL without navigating. `open` returns form, challenge and page
  states (fake page).
- [ ] `fillAndSubmit` fills each kind, uploads, clicks the one submit button, and refuses an
  unknown field, a value outside the options, a hidden field, and zero or several submit buttons
  (fake page).
- [ ] After `close()`, a `fillAndSubmit` in flight never clicks submit (fake page).
- [ ] A main-frame navigation off `hosts` is aborted; a subresource from another host isn't
  (fake route).
- [ ] playwright-core 1.63.0 pinned in `packages/gateways` and recorded in ADR-0028. No install
  script.
- [ ] Every check passes; the driver is also run by hand against the synthetic fixtures in this
  sandbox's pre-installed Chromium, and the result is reported in the PR.

## Failure modes
- The browser crashes, times out or can't find the submit button: the driver throws. The gateway
  turns it into a `driver_error` handoff (it already does), and Paul checks the posting.
- A redirect off the ATS's hosts: the navigation is aborted and `open` throws. That is also a
  `driver_error` handoff, and the gateway's own host check stays.
- A wall the driver doesn't recognize: the gateway finds no confirmation (`no_confirmation`
  handoff), so the result is never a false "submitted".

## Observability
No new events. The gateway's `apply.submit` span and handoff events already cover a driver's
outcomes. The driver logs nothing and never puts field values in an error.

## Out of scope
- Recording real ATS pages and replacing the hand-written fixtures and markers (Paul, #76).
- The worker process that runs the driver in the `apply-browser` pool (#230).
- Workday and account sign-in (#169).
- Pre-fill through the extension (#161).

## Open questions
- Whether real Greenhouse forms show reCAPTCHA as a visible widget. If they do, every Greenhouse
  submission becomes a `captcha` handoff, which is ADR-0003's intended behavior. The recorded
  pages will tell.
