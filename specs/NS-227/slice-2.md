# NS-227 (slice 2): The tailored resume's PDF, stored by SHA-256

Status: built
Requirements: APPLY-001 (the package carries the resume file), TLR-005 (the PDF is what is sent)
Rules that apply: ADR-0016, `.claude/rules/db.md`, `.claude/rules/gateways.md`,
`.claude/rules/tests.md`. Parent: #112, issue #235 item 3.

## Why
An application package names its resume by file name and SHA-256 (`PackageFile`), and the Apply
Gateway reads the bytes back at send time with its `readFile(sha256)` port, re-hashing them. Today
`tailorForJob` renders the PDF and scores it, then throws the bytes away, so nothing could serve
`readFile`. The caller that assembles a package (next slice) needs a stored resume file first, so
this slice goes before it.

## Behavior
- **`stored_file`** (`packages/db`, `file-schema.ts`, migration): one row per candidate and
  SHA-256, holding the bytes (`bytea`), the content type (`application/pdf` only, a CHECK) and the
  size. The database checks that the SHA-256 is the bytes' own (`sha256(bytes)`) and that the size
  is at most 5 MiB. Append-only (trigger), never truncated. Storing the same bytes twice stores one
  row.
- **`tailored_resume.pdf_sha256`** (nullable; versions made before this slice have none): the PDF
  of each new version, with a foreign key to the candidate's stored file.
- **`saveTailoredResume`** takes the rendered PDF's bytes. A new version stores its PDF and names
  it in the same transaction. When the content is unchanged, nothing is stored, the PDF included
  (pdf-lib stamps a creation time, so each render's bytes differ; the version keeps its first
  PDF). A version made before this slice has no PDF, and the table is append-only, so saving the
  same content again stores a new version with one. `resume.tailored` adds the PDF's SHA-256 and
  byte count (a hash and a number, no text).
- **`tailorForJob`** passes the PDF it scored, which is the one that will be sent (after Paul's
  toggles).
- **`readStoredFile(db, candidateId, sha256)`** gives the bytes or null (an unknown or malformed
  hash, or another candidate's file). The worker binds it to the Apply Gateway's `readFile` port
  once it exists (#230). `readTailoredResumes` returns each version's `pdfSha256`.

## Plan and tasks
1. `stored_file` schema and migrations (generated table and column; custom append-only trigger
   and app-role grant).
2. `file-write.ts`: `storeFileIn` (inside the caller's transaction) and `readStoredFile`.
3. `saveTailoredResume` stores a new version's PDF and names it; `readTailoredResumes` returns it.
4. `tailorForJob` passes the PDF it scored.
5. Docs: AGENTS.md, `.claude/rules/db.md`.

## Acceptance criteria
- [x] A new version stores its PDF once and names it; an unchanged save stores nothing; another
      candidate can't read it; the table refuses update, delete and truncate; the database refuses
      a hash that isn't the bytes' own, another content type, and over 5 MiB (PGlite).
- [x] `tailorForJob` saves the PDF it scored, the toggled one when Paul drops a skill (unit test).
- [x] `pnpm turbo run lint typecheck test build` passes.

## Decisions made without Paul (ADR-0016)
- Schema change: a new table and a nullable column. Bytes live in Postgres rather than the stack's
  S3 (SeaweedFS): one-page resumes are a few KB, nothing in the repo talks to S3 yet, and an S3
  client would be a new dependency. A move to object storage keeps the same `readStoredFile`.
- Diff size: about 410 lines, with the specs, without the generated snapshots and journal, over the ~300 guide.
  Most of it is tests (the CHECKs, append-only, scoping, the pre-NS-227 version); the code is
  under 100 lines, and splitting the table from its only writer would leave an unused table.

## Out of scope (rest of #235)
- The caller that assembles and files a package (next slice), DOCX files, and wiring `readFile`
  into a running worker (#230).
