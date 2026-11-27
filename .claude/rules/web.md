---
paths:
  - "apps/web/**"
  - "packages/ui/**"
---

# Web app and UI kit (ADR-0009: B · Momentum)

`apps/web` exists since NS-156 (a Next.js shell; Today, `/health` since NS-153, the Queue,
`/approvals`, since NS-139, the Pipeline, `/pipeline`, since NS-168, and Settings → Accounts,
`/settings/accounts`, since NS-198, and Settings → Search, `/settings/search`, since NS-199, both
linked from Today because the nav's five tabs are fixed). `packages/ui` doesn't exist yet: if
you are about to create it outside its ticket, stop and ask Paul. Until it lands, the color tokens
are CSS variables in `apps/web/app/globals.css`.

- Every page that shows Paul's data checks the session with `readSession` (`src/session.ts`, the
  API's `GET /me`) or `readApi` (`src/system.ts`), and renders nothing else when the API is
  unreachable (ADR-0018).
- A status is always shown in words as well as color (`.status-label`), never color alone.
- Fonts are never downloaded at build time: the build runs offline in CI.

- Use the tokens and components in `docs/design/tokens.md`. No ad hoc colors, fonts or radii.
- Light and night themes both work. WCAG 2.2 AA contrast. Never put lime text on a light background.
- Every swipe and drag has a visible button and a keyboard key (UX-043). Cards under review lock
  can't be swipe-approved (UX-041).
- Celebrations follow the ladder in tokens.md only. Respect `prefers-reduced-motion`.
- Rejections render as neutral "Closed" (`--closed`), never red. No guilt or loss copy (UX-045).
- One status vocabulary everywhere, from the application state machine (UX-020).
- Every score, skip and grade has a "why" (UX-014).
- No secrets in client code. The browser talks only to the API.
- A link to a page outside Northstar (an apply URL in "Needs your hands", NS-121) goes through
  `safeHref` (https only) and opens in a new tab with `rel="noopener noreferrer"`.
- Approvals are decided only through the API's session endpoints (`/approvals/*`, NS-139). An
  undo countdown reads the API's `effectiveAt` (the database clock); the browser only counts down.
- Application statuses are shown only through `STATUS_WORDS` (`src/pipeline.ts`, UX-020): every
  ending but an offer reads "closed" (UX-020, tokens.md).
- Passkeys (NS-178, ADR-0022) go through `src/passkey.ts` (`signInWithPasskey`, `addPasskey`),
  which takes the credentials container and fetch as arguments so tests need no browser. Adding
  one always asks for the sign-in key again; the key form stays on the sign-in page.
- Browser calls to the app's own API (`/api/*`) go through `apiFetch` (`src/client-fetch.ts`,
  NS-176): a 15 s limit. A POST that timed out may still have been applied, so its message is
  `TIMED_OUT_MESSAGE` ("may have gone through"), never "nothing was done".
- Settings → Accounts (NS-198) never shows an account email: rows are built field by field
  (`accountRows`, `noticeRows` in `src/accounts.ts`), and a notice's text is fetched only when
  Paul asks for it. A password shows only when Paul clicks "Reveal password" (NS-246): a fresh
  passkey check through `revealPassword` (`src/reveal.ts`, the API's `/vault/reveal` routes), held
  only in that row's component state, and cleared after `MASK_AFTER_MS` (30 s), on Hide or when he
  leaves the page (`startMaskTimer`). Never put it in storage, a cookie, the URL or a log.
- An "Email reply" in the Queue (NS-237) shows its stored draft only when Paul asks ("Show the
  reply", the API's `GET /approvals/reply`), as plain text through `replyLines`: the recipient
  first, with the other-domain warning under it. An approve of a reply with no draft comes back
  `missing_draft` and stays in the queue; one to another domain is approved only on its own
  (`approve_alone` in a batch). Its Edit button (NS-203 slice 2) changes only the body, and only
  through `POST /approvals/edit-reply` after `editProblem`; a timeout says `TIMED_OUT_MESSAGE`,
  and a `409 not_pending` reads as already done (a second click, or a decision meanwhile).
- The run inspector (NS-154) fetches a feed line's run (`GET /feed/run`) only when Paul asks, and
  shows it as plain text through `src/run.ts` (`callLine`, `totalsLine`).
- Pipeline filters (NS-207) live in the URL (`parseFilters`, `filterQuery` in `src/pipeline.ts`)
  and are applied by the API, never only in the browser. Today's counts (`src/today.ts`) come from
  the same lists their pages show; one that can't be read says so, never 0.
- Pipeline metrics (NS-208, `/pipeline/metrics`, `src/metrics.ts`): every rate shows its count,
  and one with too few data points reads "not enough data yet", never a percentage (DX-003).
- The Grow tab (NS-214, `/grow`, `src/grow.ts`) shows each track's figures through `trackCard`
  and a review through `reviewLines`, every status in words and no guilt copy (UX-032: never
  "missed", "behind" or a broken streak). A check-in form keeps one idempotency key until a save
  succeeds, so a double submit stores one.
- Stuck work (NS-215, on `/health`, `src/dead-letters.ts`) shows a dead letter's kind and reason
  in words (`letterLine`), never its subject, and after Retry, Skip or Hand off says what happens
  next for that kind (`nextStep`). A new producer's kind gets its words there.
- The Inbox (NS-165, `/inbox`, `src/inbox.ts`) shows Gmail ids, counts, steps and flags only:
  subjects, senders and bodies are never stored, so never fetch or show them. A thread's link is
  shown only when `safeHref` passes and it points at `https://mail.google.com/`.
  A thread's recruiter grade (NS-238) shows as words through `gradeWords`, with every reason
  (UX-014); an unknown reason code is left out, never shown raw.
- Model spend (NS-219, on `/health`, `src/spend.ts`) shows spend against each cap and every
  paused kind of work in words (`spendView`), from the API's `GET /system/spend`, whose paused
  list comes from `pausedPriorities`, the gateway's own rule. Unreadable spend says so, never
  "nothing is paused".
- The Career DNA page (NS-130 slice 8, `/career-dna`, `src/career-dna.ts`) is read-only: each
  dimension's band in words with its evidence count (`dimensionRow`) and what changed
  (`changeSummary`). The report holds scores and counts only: never fetch or show atom or story
  text or ids on it.
  Since slice 9 its "Directions" and "Proof to build" sections (`src/career-directions.ts`:
  `directionRow`, `gapLine`) come from `GET /career-dna/directions`, read apart from the report so
  either can fail alone. Role and requirement text comes from job postings: shown as text only,
  already cleaned by the API's `postingText`.
- Jobs (NS-130 slice 10, `/jobs`, `src/jobs.ts`) is read-only: each job through `jobRow`, its
  posting link only through `safeHref` (new tab, `noopener noreferrer`), and its fit reason in
  words through `reasonWords` (UX-014; an unknown code is left out, never shown raw). The order and
  the role filter are the API's (`GET /jobs`), never the browser's. Titles, companies and places
  come from postings: text only.
- Interviews (NS-240 slice 5, `/interviews`, `src/interviews.ts`, linked from Today) shows each
  detection in words (`interviewRow`): the format, the job's own title and company, the time and
  an interviewer count, never an invite's title, an address or a name. A waiting one reads "Not
  verified" (an invite isn't authenticated) with Confirm and Dismiss through
  `POST /interviews/decide`; neither choice moves a status, and the page says so in its intro and
  after a choice (`decidedMessage`, in one message area that stays mounted).
- The Inbox's confirm queue (NS-262) links or dismisses a thread only through
  `POST /inbox/decide`. The choice of application comes from `GET /inbox/link-targets`; when it
  can't be read there is no Link choice, never a guessed one. The answer is worded by
  `decidedMessage` and `decideProblem` (`src/inbox.ts`), and a linked thread reads "Linked by you".
