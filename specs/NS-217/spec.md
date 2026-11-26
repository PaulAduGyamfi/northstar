# NS-217: Trust only Gmail's own Authentication-Results header

Status: built
Requirements: INB-011 (sender verification), VER-002 (catcher sender check)
Rules that apply: ADR-0016, `.claude/rules/tests.md`. Parent: #205's parent chain (Paul's).

## Why
`headersOf` reads Gmail's own `Authentication-Results` (authserv-id `mx.google.com`) when there
is one, but falls back to the first header when there isn't. A sender can write their own
`Authentication-Results: mx.example.com; dmarc=pass header.from=<any domain>`, so a message
Gmail didn't stamp (or one read before Gmail's header) could make a forged domain look verified.

## Behavior
- `authenticationResults` in `packages/inbox/src/gmail.ts` returns only the first header whose
  authserv-id is exactly `mx.google.com`. With none, it returns `null`, so the sender is
  unauthenticated (`authenticatedDomains(null)` is `[]`).
- `authenticatedDomains` (`prefilter.ts`) also counts results only when the header's authserv-id
  is `mx.google.com`, so a header from any other source (the catcher's window, a stored value)
  can't verify a sender either.
- Test fixtures that used `mx.example.com` as the authserv-id move to `mx.google.com`. These
  assertion changes were approved in the delegated decision on #205.

## Acceptance criteria
- [x] A message with only a non-Google header reads `authenticationResults: null`.
- [x] `authenticatedDomains` and `isAuthenticatedSender` return nothing for a non-Google
      authserv-id, including a lookalike (`mx.google.com.evil.example`).
- [x] `pnpm turbo run lint typecheck test build` passes.

## Out of scope
- Any change to how the results are parsed after the authserv-id.
