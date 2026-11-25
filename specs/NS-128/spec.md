# NS-128: Browser extension capture (Save to Northstar)

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: SRC-002 (capture a posting from any page Paul is viewing). GitHub issue #51.
Rules that apply: ADR-0019 (this ticket's extension token), ADR-0003 (no background crawling; LinkedIn, Indeed and Glassdoor are never
fetched), ADR-0018 (the API's request checks), `.claude/rules/extension.md` (minimal permissions,
user-initiated capture, only the Northstar API with its own scoped token, page content is
untrusted), `.claude/rules/gateways.md` (`safeFetch` for every page fetch), NFR-SEC-004 (untrusted
text is data), `.claude/rules/tests.md`.

## Why
Many postings live on sites Northstar must never fetch (LinkedIn, Indeed, Glassdoor) or behind a
sign-in. Today Paul saves the text to a file and runs `jobs add --text`. A button in his own
browser does the same in one click, from the page he is already reading.

## Behavior
1. **`apps/extension`** (Chrome MV3, TypeScript compiled by `tsc`, no framework or dependency):
   - Permissions: `activeTab`, `scripting` and `storage`. The one host permission is the local
     API (`http://127.0.0.1:8787/*`), so the popup can call it. No content scripts, no background
     page, nothing runs until Paul clicks.
   - The popup's "Save to Northstar" button reads the active tab's URL, title and visible text
     (`document.body.innerText`, capped at 20,000 characters: the model reads the first 12,000, `PAGE_LIMIT`) through `scripting.executeScript`,
     then sends `{ url, title, text }` to the API.
   - An options page stores the extension token and the API origin in `chrome.storage.local`.
     Nothing else is stored.
   - The popup shows a plain result: saved (new or already known), with the fields found; refused,
     with the reason; or couldn't reach Northstar.
2. **`POST /jobs/capture`** in `apps/api` with a new `auth: "extension"`:
   - The extension token's SHA-256 is `NORTHSTAR_EXTENSION_TOKEN_SHA256`, compared in constant
     time to the `Authorization: Bearer` token. When it isn't set, every extension request gets
     401. Wrong tokens count toward sign-in's limit (5 a minute across both, then 429).
   - Scoped: an extension token never opens a session endpoint, and a session cookie never opens
     an extension endpoint.
   - Extension requests, of any method, must carry a `chrome-extension://<id>` Origin (403
     otherwise). The token is the real check, because an id can't be known before Paul loads the
     extension.
   - The body limit is per endpoint: capture allows 96 KB, everything else keeps 16 KB.
   - A posting on a known ATS (`detectAts`: Greenhouse, Lever, Ashby, Workday, SmartRecruiters,
     Workable) is read by `ingestUrl(url)`, the same path as `jobs add <url>`, through the ATS's
     own API. When that is refused, fails or finds no job, and for every other page, the handler
     calls `ingestText(url, text)`, the same path as `jobs add --text`. The server never fetches a
     host the page's owner controls: `safeFetch` checks an address and then resolves the name
     again, and a page owner controls their DNS, so they could point the second lookup at a local
     address (security review). LinkedIn, Indeed and Glassdoor are never fetched either. The page
     text only ever goes to the `job-extract` route as untrusted data (its provenance check
     applies).
   - The answer is the status, the job id, and the names of the fields found and missing, never
     field values.
3. **Wiring:** the API connects to `DATABASE_URL` and builds the LLM gateway only on first use
   (as `jobs add` does), so sign-in keeps working without `ANTHROPIC_API_KEY`.

## Acceptance criteria
- [ ] A capture without a token, or with a wrong one, gets 401. A session cookie doesn't open it.
      The extension token doesn't open `GET /me`.
- [ ] A capture with a non-extension Origin gets 403.
- [ ] A capture body up to 96 KB is read, and other endpoints still stop at 16 KB.
- [ ] A capture on a known ATS reads the link first and stores what it read, falling back to the
      page text when that fails. Any other page, LinkedIn included, is stored from its text with
      no server fetch. The answer lists field names only.
- [ ] Five wrong tokens in a minute make the next capture 429, even with the right token.
- [ ] Bad input (no URL, empty text) is 400.
- [ ] The extension's request is built with the token, JSON and the capped text. Its result
      messages cover saved, already known, refused and unreachable (extension tests).
- [ ] The manifest asks only for `activeTab`, `scripting`, `storage` and the local API host
      (a test reads `manifest.json`).
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **API down or token unset:** the popup says so, and nothing is stored.
- **A page that is mostly navigation:** the model route finds no job (`not_a_job`), and the popup
  says it couldn't find a posting.
- **The model is unavailable:** the capture answers `failed`, and Paul can retry.

## Observability
`api.request` spans as today, plus `northstar.auth.outcome` for extension auth. `job.ingest`
spans come from `packages/sources` unchanged. A stored job writes its own domain events
(`job-write.ts`).

## Out of scope
- The human handoff through the extension (NS-121, APPLY-006).
- Reading Paul's LinkedIn profile (PRF-002), course pages (GRW-005).
- Publishing to the Chrome Web Store. Paul loads it unpacked.
