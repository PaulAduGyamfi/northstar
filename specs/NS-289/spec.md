# NS-289: Remove the regular-expression denial-of-service risk in htmlToText

Status: approved (autonomous lane, ADR-0016; parent #461, issue #484)
Requirements: SRC-001 (adding a job from a link), NFR-SEC-004 (untrusted text is data), RES-005
Rules that apply: `.claude/rules/gateways.md` (job sources), `.claude/rules/tests.md`.

## Why
`htmlToText` (`packages/sources/src/extraction.ts`) reads untrusted pages: links pasted to
`jobs add`, browser captures and feed items (`boards/text.ts`'s `cleanHtml`). Its regex chain was
super-linear on hostile input. It rescanned the rest of the page for every unclosed `<script>`
(`<(script|style|noscript)[\s\S]*?<\/\1>`), every `<` with no `>` after it (`<[^>]+>`) and every
unclosed `<li` (`<li[^>]*>`). A 2 MB page could stall the run that read it for minutes.

## Behavior
- `htmlToText` strips tags in one forward pass (`stripTags`). Each search starts at or after the
  current position, and a search that found nothing is remembered.
- Output on well-formed pages is unchanged:
  - script, style and noscript elements are dropped with their content (a space in their
    place);
  - `<br>` and closing `p`, `div`, `li`, `h1`–`h6`, `ul`, `ol`, `tr` and `section` tags are line
    breaks;
  - `<li…>` is `- `, and any other tag is a space;
  - an unclosed script, or a `<` with no `>` after it, stays text as before;
  - entities and whitespace are handled as before.
- Only malformed pages where two tags overlap (`<a <br>`) may read differently, and still with no
  tag in the text.

## Acceptance criteria
- [ ] A parity test: the new `htmlToText` equals the earlier regex chain (kept in the test) on
      well-formed pages.
- [ ] 200,000 unclosed `<script>` tags, 500,000 lone `<` and 200,000 unclosed `<li` each read in
      under a second. The old chain needs about 70 s for the first.
- [ ] The existing sources tests pass unchanged; no assertion loosened.

## Failure modes
None new: pure code.

## Observability
None (no I/O).

## Out of scope
`packages/inbox`'s own HTML handling (another agent's lane). `research/html-text.ts` (NS-283)
already scans linearly; sharing one stripper between them is possible later.

## Open questions
None.
