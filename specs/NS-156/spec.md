# NS-156: Web app and API scaffold with Paul's sign-in

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: APR-001 (only Paul's authenticated path will reach the approval queue), UX-* (shell
and navigation, `docs/requirements/12-ui-ux.md`), NFR-SEC-* (no secrets in client code, least
privilege). GitHub issue #107.
Rules that apply: ADR-0018 (this ticket's sign-in decision), ADR-0002 (only Paul's authenticated UI path may later call `decideApprovals`
and `setKillSwitch`), ADR-0005 (Next.js PWA, typed REST with Zod), ADR-0009 and
`docs/design/tokens.md` (B · Momentum), ADR-0011 (toolchain), `.claude/rules/web.md`,
`.claude/rules/tests.md`, AGENTS.md ("No secrets in client code. The browser talks only to the
API"; settings through one typed config module).

## Why
Nine tickets (NS-121, 128, 130, 139, 153, 154, 163, 165, 168) wait on an app. They need three
things: a web shell to put pages in, one API the web app and the extension talk to, and one way to
know a request comes from Paul.

## Behavior
1. **`apps/api`** (Node's `http`, no web framework): the BFF on `127.0.0.1` only.
   - One endpoint pattern, `endpoint({ method, path, auth, input, output, handler })`: the body
     is parsed with the input Zod schema (400 with the issue paths, never the values), and the
     handler's result is checked against the output schema before it is sent (500 if it doesn't
     match). `auth: "session"` endpoints refuse a request without a live session (401) before
     the body is read.
   - Every request gets an `api.request` span with the method, the route pattern and the status.
     Never the body, the cookie or the query string.
   - Endpoints in this slice: `POST /auth/sign-in`, `POST /auth/sign-out`, `GET /me`.
   - Requests whose `Host` isn't the API's own loopback host and port are refused (421), against
     DNS rebinding. A `POST` must carry `Content-Type: application/json` and, when an `Origin`
     header is present, the web app's origin (403 otherwise), against cross-site requests.
2. **Paul's sign-in (slice 1: a local sign-in key).** Paul generates a random key and stores only
   its SHA-256 in `.env` (`NORTHSTAR_SIGNIN_KEY_SHA256`). `POST /auth/sign-in { key }` compares the
   key's hash with it in constant time.
   - On a match: a new 32-byte random session token in an `HttpOnly; SameSite=Strict; Path=/`
     cookie (12 h). The API keeps only the token's SHA-256 and its expiry, in memory, so a
     restart signs Paul out.
   - Wrong key: 401, the same response for every failure. After 5 failures in a minute, 429 until
     the minute is up.
   - `POST /auth/sign-out` forgets the session and clears the cookie.
   - Passkeys (system-design §2) need a credential table, so a migration. They are a follow-up
     issue, and the ADR says so.
3. **`apps/web`** (Next.js App Router, React): a shell with the `PillNav` tabs from tokens.md
   (Today, Queue, Pipeline, Grow, Inbox) and one authenticated page, Today, as a placeholder.
   - `/api/*` is rewritten to the API, so the browser talks to one origin and the cookie stays
     same-site. The web app holds no secret.
   - The Today page asks the API `GET /me` with the incoming cookie. 401 redirects to
     `/sign-in`. Any other failure shows "Northstar API unreachable" and never the page.
   - `/sign-in` posts the key to `/api/auth/sign-in`.
   - The B · Momentum color tokens are CSS variables, with light and night themes from
     `prefers-color-scheme`. Fonts fall back to system fonts (no font download at build time).
   - A web app manifest (PWA install). No service worker yet.
4. **Config** through one typed module per app: `NORTHSTAR_SIGNIN_KEY_SHA256` (64 hex),
   `NORTHSTAR_API_PORT` (default 8787), `NORTHSTAR_WEB_ORIGIN` (default `http://127.0.0.1:3100`)
   for the API, and `NORTHSTAR_API_ORIGIN` (default `http://127.0.0.1:8787`) for the web app. New
   settings go in `.env.example` with placeholders.
5. **ADR-0018** records the sign-in method, the in-memory sessions and why passkeys come later.

## Acceptance criteria
- [ ] An unauthenticated request to `GET /me` is refused with 401, and an authenticated one gets
      `{ user: "paul" }` (API tests, through a real `http` server on a random loopback port).
- [ ] A wrong key gets 401 and no cookie. A sixth failure within a minute gets 429, even with the
      right key. The right key gets an HttpOnly, SameSite=Strict cookie.
- [ ] A signed-out or expired session is refused.
- [ ] A foreign `Host` is refused (421). A cross-site `Origin` and a non-JSON POST are refused
      (403, 415).
- [ ] Bad input is 400 without echoing values, and output that fails its schema is 500.
- [ ] The Today page's guard redirects to `/sign-in` on 401, renders for a signed-in session, and
      never renders when the API is down (web tests).
- [ ] `api.request` spans carry the method, route and status, never the cookie or the body.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **The API is down:** the page shows "API unreachable" and nothing else, so nothing renders
  unauthenticated.
- **API restart:** sessions are gone, and Paul signs in again (accepted for a local single user).
- **`.env` missing the key hash:** the API refuses to start with a message naming the setting,
  never a value.
- **Guessing the key:** 256-bit keys, plus the 5-per-minute limit.

## Observability
`api.request` spans: `http.request.method`, `http.route`, `http.response.status_code`. Sign-in
outcomes go on the span as `northstar.auth.outcome` (`ok`, `wrong_key`, `throttled`). No domain
events: signing in changes no domain state (an audit event can come with the passkey ticket).

## Out of scope (follow-up issues, `agent-filed`, `Parent: #107`)
- Passkey sign-in (WebAuthn) with a stored credential: needs a migration.
- `packages/ui` with the Tailwind theme and components, the service worker and push.
- Every real page (each arrives with its ticket).
