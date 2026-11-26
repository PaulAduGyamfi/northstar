# NS-209: Import Paul's personal site into the profile (slice 1 of #187: the site)

Status: accepted (autonomous lane, ADR-0016)
Requirements: CPG-001 (profile sources), ADR-0004 (provenance)
Rules that apply: `.claude/rules/db.md`, `.claude/rules/tests.md`
Parent: #42

## Why
#187 lists three follow-ups to NS-133: GitHub repositories, the personal site, and reconciling
sources. The site needs no network: Paul supplies its text himself. This slice adds it as its
own profile source, the way the LinkedIn export was added.

## Behavior
1. **packages/db** (one migration): `profile_source.kind` may be `site`
   (`PROFILE_SOURCE_KINDS`, the CHECK). A site import supersedes only an earlier site import, and
   its `profile.imported` event says so. Every resume reader keeps filtering `kind = 'resume'`,
   so site atoms reach no scoring, story or thesis yet.
2. **packages/profile** (`site.ts`, plain code, no model): `parseSiteText(text)` reads a file Paul
   saves from his site:
   - `## Project` headings start a project;
   - an optional `Link: https://…` line under it is the project's evidence link (https only);
   - every other non-empty line under a heading is one atom, its text verbatim (a leading `- ` or
     `* ` dropped);
   - a line before any heading, a bad link, a heading with no lines, or no projects at all refuses
     the whole file, naming the line.
   `checkSiteProvenance` proves every atom's quote is a line of the file. The import's hash is the
   file's text, so an unchanged file stores nothing.
3. **CLI:** `profile import-site data/<file>` prints counts only. Paul only: it's his data.

## Acceptance criteria
- [ ] A good file gives one atom per line with its project's link, and quotes that are lines of
      the file.
- [ ] Each bad case refuses the file and names the line; nothing is stored.
- [ ] A site import stores a `site` source beside the resume and LinkedIn ones and supersedes only
      an earlier site import; the same file again stores nothing.
- [ ] Resume readers still see only the resume.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
A bad file stores nothing and says which line. No database: the command fails with its usual
message.

## Observability
`profile.imported` with `kind: "site"` and counts, as for LinkedIn.

## Out of scope
- GitHub repositories (#187 item 1): a fetch from `api.github.com` is a new network host, which
  needs its own decision; a later slice.
- Reconciling sources (#187 item 3) and using site atoms in scoring or tailoring.

## Decisions made without Paul (ADR-0016)
- **File format:** `## Project` headings, an optional `Link:` line, one atom per other line. Plain
  enough to paste from any site, and every atom is a verbatim line.
- **Atoms have no role:** site projects aren't employment; `role_id` stays null.
- **Schema change:** one migration widening the kind CHECK.
