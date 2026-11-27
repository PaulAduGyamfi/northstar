# ADR-0028 — The form driver runs on playwright-core with an installed Chromium

**Status:** Accepted (Paul, by delegation to the orchestrator on 2026-11-27) · **Date:** 2026-11-26

## Context
APPLY-008 asks for a browser that fills and submits application forms. NS-120 built the Apply
Gateway against a `FormDriver` contract (`packages/gateways/src/apply/driver.ts`) and tested it
with a fake, so nothing can submit yet. ADR-0005 already names Playwright for the stack. A
browser library is still a new dependency for `packages/gateways`:
- AGENTS.md asks for an exact version on a release at least 14 days old;
- ADR-0016 item 4 says an agent records the choice;
- Paul's delegation on #76 approved Playwright for this package.

Two things force the details:
- `pnpm-workspace.yaml` lets no dependency run an install script without Paul's approval.
- CI and the agent sandbox may not download browsers, because that is network beyond the
  registry.

## Decision
- **`playwright-core@1.63.0`** (Apache-2.0, released 2026-09-04). It has no dependencies and no
  install script, and it never downloads a browser. 1.65.1 was the newest release outside the
  cooldown. 1.63.0 is pinned instead because it matches the Chromium build pre-installed in the
  agent sandbox (`chromium-1243`), which lets the driver be checked there by hand.
- Only `src/apply/browser/launch.ts` imports it.
  - `launchFormDriver({ hosts, executablePath? })` starts headless Chromium for one submission.
  - It opens a fresh context with downloads off, service workers blocked and the default user
    agent: no stealth and no fingerprint changes (ADR-0003).
  - It returns the driver, whose `close()` closes the browser.
- The worker passes the installed browser's `executablePath` (#230). Nothing downloads one.
- The driver (`src/apply/browser/driver.ts`) talks to a small `DriverPage` interface that a real
  Playwright `Page` satisfies (`tsc` checks it). Its tests run on a fake page.
- Reading a page (`src/apply/browser/collect.ts`) is one self-contained function sent with
  `page.evaluate`. It is written against a small DOM shape, so its tests run in Node without a
  browser.
- The driver stays on the adapter's hosts:
  - it refuses an off-host apply URL before navigating;
  - it aborts any main-frame navigation request off the hosts through `page.route`, using
    `fallback` so other handlers still see the request;
  - it refuses any snapshot whose page URL is off the hosts, since `page.route` doesn't see a
    server's redirect hops;
  - it closes any popup.
- After `close()` it takes no further browser action, so a timed-out submit never presses the
  button later.
  - Every action has the step's time limit (`setDefaultTimeout`).
  - `launchFormDriver`'s close shuts the whole browser at once.
- It reports a visible CAPTCHA, a sign-in, a one-time code or an account wall as a challenge and
  never solves one (ADR-0003).

## Alternatives considered
- **The `playwright` package:** it wraps the same core and adds the browser download command.
  Nothing here may download a browser, so the extra command is surface with no use.
- **`puppeteer`:** its install script downloads Chrome, which the workspace refuses without
  approval. It also isn't the stack's named tool (ADR-0005).
- **Raw Chrome DevTools Protocol:** no dependency, but the waiting, upload and navigation handling
  would be hand-written, more code to get wrong at the one step that can't be taken back.
- **Testing in a real browser in CI:** it needs a browser on the runner (a download, or the
  runner image's own Chrome) and a `.github/` change. The fake page and fake DOM cover the logic,
  and the real browser is checked by hand until a worker environment has one.

## Consequences
- The gateway can now drive a real form, but the field markers (the submit button and challenge
  signals) are hand-written. Recorded Greenhouse, Lever and Ashby pages must confirm them; that
  needs Paul, because recording uses network beyond the registry (#76).
- Every machine that runs the `apply-browser` pool needs an installed Chromium that matches
  1.63.0, and its path in the worker's settings.
- An upgrade means a new exact version past the cooldown, a matching browser, and a by-hand run
  against the synthetic pages.
- `page.evaluate` runs in the page's main world, beside the page's own script. The driver checks
  the shape of what `collectPage` reports (`checkCollected`). A page whose own origin is hostile
  could still make it read a different form or click a different option. That script could
  rewrite the submitted payload anyway, so this adds no new power, but the check isn't made from
  outside the page.
- A popup is closed but never routed, so it may load another host before it closes. The main page
  is what gets filled.
- The worker must not set `DEBUG=pw:*`, `PWDEBUG` or tracing for this process: Playwright's API
  logs and traces would record the values typed into fields.
- Open question: whether real Greenhouse forms show a visible reCAPTCHA. If they do, every
  Greenhouse submission becomes a `captcha` handoff, as ADR-0003 intends.
