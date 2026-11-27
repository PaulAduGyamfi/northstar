# NS-240 slice 5: the interviews API and confirm page

Status: in progress (autonomous lane, ADR-0016)
Requirements: CAL-002, UX-014 · ADR-0018 (session), ADR-0026 · Issue #271
Slices 1–4: #305, #320, #338, #349.

## Why
Detections are stored and Paul's decision has a write path (`decideInterview`), but nothing shows
them to him or lets him confirm or dismiss one.

## Behavior
- `GET /interviews` (session only): the current detections from `listInterviews`, each with its
  format, start, end, interviewer count, decision, and the job's own title and company
  (`readFeedNames` on `application:<id>`). Never the calendar event id, an invite's title, an
  address or a name. An unreadable store answers 503, never an empty list.
- `POST /interviews/decide` (session only): `{ detectionId, decision: confirmed | dismissed }`
  through `decideInterview`; `404 not_found`, `409 superseded`, `409 already_decided`, `503`.
- `/interviews` in the web app, linked from Today (the nav's five tabs are fixed): waiting
  detections first, each "Not verified" with Confirm and Dismiss, then decided ones. After a
  choice the page says neither moves the application's status, and reloads.
- No migration, no new dependency.

## Acceptance criteria
- [x] Both endpoints answer 401 without a session or with the extension token, touching nothing.
- [x] The list carries the job's names and never the calendar event id.
- [x] Each refusal maps to its own code; a bad decision or id is refused before any write.
- [x] The page's words come from tested functions.
- [x] `pnpm turbo run lint typecheck test build` passes in `apps/api` and `apps/web`.

## Out of scope
- The run's caller (#230); company domains (#313); prep blocks (NS-241, #275).
