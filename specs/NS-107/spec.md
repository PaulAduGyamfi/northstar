# NS-107: Clickable B · Momentum prototypes for UX-002 (Queue stack + compact, Pipeline, Growth, Diagnostics, Settings)

Status: approved by Paul (2026-11-24; no unit tests for the prototype, docs/design/prototypes/, one PR, phone feel checked by Paul)
Requirements: UX-002 (usability check on a clickable prototype), UX-001, UX-010…UX-020,
UX-030…UX-034, UX-040…UX-047 (`docs/requirements/12-ui-ux.md`). ADR-0009 (B · Momentum).
GitHub issue #8.
Rules that apply: AGENTS.md (public repo, synthetic data only, no deps without asking),
`.claude/rules/web.md` (tokens only, both themes, AA contrast, no lime text on light, every
swipe has a button and a key, review lock, celebration ladder, Closed never red, one status
vocabulary, a "why" for every score and skip), `docs/design/tokens.md`.

## Why
ADR-0009 picked B · Momentum from static screenshots. UX-002 says Paul must try it before we
build: he does five real tasks on a clickable prototype without help. If he can't find why a
job was skipped, or the card stack feels like rubber-stamping, we want to learn that now, while
it is cheap to change, not after `apps/web` exists. The prototype is a design artifact: it fakes
the data and the agents and exists only to test the flow and the feel.

## Behavior
A static, clickable prototype in `docs/design/prototypes/`: `index.html`, `prototype.css`,
`data.js`, `app.js`. Plain HTML, CSS and JavaScript with no build step and no dependencies. It
opens by double-clicking `index.html` (file://) or from any static server. Fonts come from
Google Fonts, like the mockups.

- **Data:** one synthetic week (invented companies on `example.com`, invented roles, comp and
  dates) held in memory. Actions change it for the session: approving a card moves it into
  the pipeline. Reloading resets it. Nothing is sent anywhere.
- **Shell:** the `PillNav` with Today, Queue, Pipeline, Grow and More (Diagnostics,
  Settings). Inbox shows "Not in this prototype". It also has a theme toggle (light / night),
  a `HealthDot`, and a `?` key that lists every shortcut. Each screen has its own URL hash
  (`#queue`), so a link opens that screen.
- **Today** (UX-010): what needs you, as counts linked to the queue, handoffs and failures; the
  `InputRing` and `QuestList` with a banked rest day; and the `CrewFeed`. The feed includes one
  failed step that explains itself, which is task 4.
- **Queue, stack view:** the `CardStack` with the hero `JobCard` (freshness tag first, fit
  breakdown, "Why it's a match"). It has Approve, Skip and Edit buttons and the keys A, S, E,
  J and K. Drag-to-swipe works with a mouse or touch. A card with a review lock (new narrative
  answer, low confidence, first-time form or provenance warning) can't be approved by swipe or
  key: that opens it for review (UX-041). The stack ends with a `BatchCard` ("These N match
  your auto-rules. Approve all?"), which is task 1, then the "Queue clear" scene.
- **Queue, compact view** (UX-042): the same queue as a dense list with the same keys. One
  toggle switches views, and the choice is remembered for the session.
- **Skipped:** a "Skipped by Scout" list with a one-click why for each job (UX-014), which is
  task 2.
- **Approve:** an `UndoToast` with a countdown (UX-016), and the small coral celebration from
  the ladder: "Applied N min after posting". Individual approvals and skips get no celebration.
- **Pipeline:** the `JourneyTrack` with stage tokens in the state-machine vocabulary and colors
  (UX-020). Each move has a menu (UX-043). Closed jobs sit in a neutral gray "Learned-from"
  tray, never red (UX-032). It also shows the `HandoffCard` "Needs your hands (~90 s)" and the
  once-only interview celebration, triggered by a demo button.
- **Grow:** growth tracks with progress, the weekly growth ring, and a "Log progress" form
  (minutes, note) that updates the ring and the quest. That is task 5. Rest days are banked,
  progress decays slowly, and no copy blames you for a missed day (UX-045).
- **Diagnostics:** the `DiagnosisCard` (leakiest stage, hypothesis and its status) and a funnel
  where Closed is data, not failure.
- **Settings:** target roles, locations, **comp floor** (task 3: changing it re-ranks the queue
  and the change shows in the crew feed), the autonomy dial and daily caps. Changes apply
  immediately with an undo toast, not a confirm dialog.
- **⌘K / Ctrl K:** the `CommandPalette` can jump to any screen, run "why was X skipped",
  open "change comp floor" and pause auto-apply.
- **Themes and motion:** every color comes from the tokens.md variables, for both themes.
  Springs use the tokens.md curve, and `prefers-reduced-motion` turns them into 150 ms fades
  with no flying cards.
- **Accessibility:** every control is a real button or input with a label, focus is visible,
  every action works from the keyboard, and status is never shown by color alone.

**`docs/design/prototypes/usability-check.md`** is the UX-002 protocol:
- the five tasks, worded as Paul would get them, without hints;
- what counts as done;
- a results table for Paul (done without help yes/no, time, where he hesitated, what he'd change).

## Acceptance criteria
- [ ] `pnpm exec biome check docs/design/prototypes` reports no problems.
- [ ] Headless Chrome opens every screen hash in both themes with zero console errors.
      Screenshots of all 12 (6 screens × 2 themes) go in the PR.
- [ ] A computed contrast check of every text and background token pair the prototype uses
      meets WCAG AA (4.5:1 body, 3:1 large text and UI) in both themes, and no lime text sits
      on a light surface. The table goes in the PR.
- [ ] `grep` finds no hex color in `prototype.css` or `app.js` outside the two token blocks.
- [ ] `grep` for `@` in `data.js` finds only `example.com` addresses. All names, companies
      and numbers are invented.
- [ ] Each of the five tasks can be done with the keyboard only and with the mouse only. I
      walk through each in headless Chrome by key events and record the steps in the PR.
- [ ] A review-locked card can't be approved with A or by swipe: it opens for review. Shown in
      the walkthrough.
- [ ] Paul does the five tasks in `usability-check.md` without help and fills in the results
      table (UX-002). If a task fails, the fix goes in this PR or becomes a follow-up issue,
      as Paul decides.
- [ ] `checks` is green on the PR.

## Failure modes
- **Fonts can't load (offline):** the CSS falls back to system sans and mono. Layout holds and
  only the typeface changes.
- **file:// limits:** no ES modules and no fetch, so the scripts are classic `<script>` tags
  and the data is inline JS. The prototype works with no server.
- **Old browser or JavaScript off:** a `<noscript>` line says it needs a current browser with
  JavaScript. This is a prototype, not the product.

## Observability
None. It's a static design artifact with no events or spans. The real UI emits them later
(OBS-002).

## Out of scope
- `apps/web`, `packages/ui`, Next.js, Tailwind, a real API or real data. The prototype code is
  not reused in production. The production UI arrives with its own ticket, built to tokens.md.
- The Inbox, Activity run inspector, Accounts and Outreach screens. Push notifications and the
  mobile PWA install (mobile layout is checked at 390 px width only).
- Haptics and the full-screen offer celebration (only the interview one is shown).

## Open questions
1. **No automated tests.** AGENTS.md wants a test for every behavior change. This is a
   throwaway design artifact with no package and no production code. Recommended: biome, the
   headless-Chrome render and keyboard walkthrough, the computed contrast table, and Paul's
   UX-002 check stand in for unit tests. The alternative is a workspace package with a DOM test
   setup and new dependencies, which seems like too much for a prototype.
2. **Where it lives.** Recommended: `docs/design/prototypes/`, next to the mockups, because it
   is design work and not app code. Inferred from docs/design/README.md ("then clickable
   prototypes … for UX-002").
3. **Diff size.** About 1,600 lines of HTML, CSS and JavaScript, well over AGENTS.md's ~300.
   It is one artifact that can't be usefully split by screen, so it gets one commit per screen.
4. **Mouse and touch drag** is plain pointer events, tested in headless Chrome. Real-phone feel
   is only checked by Paul.
