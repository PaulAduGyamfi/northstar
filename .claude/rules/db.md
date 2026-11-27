---
paths:
  - "packages/db/**"
---

# Database schema and migrations (Postgres 16 + pgvector, Drizzle)

Lives in `packages/db` since NS-105. The event log design and PGlite tests are ADR-0012. The
profile graph (NS-110) is in `src/profile-schema.ts`, the story bank (NS-111) in
`src/story-schema.ts`.

- `profile_source.kind` is `resume`, (NS-133) `linkedin` or (NS-209) `site`, each with its own
  current source.
  Every reader that means "Paul's resume" filters `kind = 'resume'` as well as "not superseded";
  a new reader must too, or LinkedIn or site rows leak into scoring, stories and the thesis.
- Locked facts (CPG-004): `role` employer/title/dates/is_current and `education` school/degree/field/dates
  are guarded by a trigger. Change them only through `editLockedFact` (Paul's own edits); never
  set `northstar.locked_edit` anywhere else.
- Approved stories (NS-111) are locked by a trigger: no update or delete, and no change to their
  `story_atom` links. Write the story bank only through `story-write.ts`. `story_answer` holds
  Paul's own words: never copy them into events, spans, logs or fixtures.
- The official employment record (NS-112, DX-011) is `employment_fact`, written only through
  `facts-write.ts`. A new record supersedes the old rows; nothing is deleted. Its events carry
  counts only, never employers, titles or dates.
- The funnel backfill (NS-113) stores `funnel_message` (Gmail ids, dates and extracted fields;
  never a subject, body or address) and `funnel_manual_row` (Paul's tracker export, replaced per
  import), through `funnel-write.ts` only. Funnel records are derived in `packages/funnel`, never
  stored. Funnel events carry counts and fixed names only.

- Migrations are generated (`db:generate`; `--custom` for SQL Drizzle can't express, such as
  extensions and triggers), reviewed and committed. Never edit an applied migration; add a new one.
- The owner's credentials (`DATABASE_MIGRATION_URL`, `POSTGRES_PASSWORD`) live only in the root
  `.env`, for compose and `db:migrate` (NS-235). Apps load `.env.app`, and `loadDbConfig` refuses
  to start while either is set; never read the owner's settings anywhere but `src/migrate.ts`.
- The apps connect as `northstar_app` (NS-212, migration 0065), which owns nothing. A migration
  that adds a table, or an append-only trigger, ends with `SELECT northstar_grant_app_role();`:
  it grants SELECT and INSERT on tables a `*_reject_change` trigger guards on UPDATE or DELETE
  (plus UPDATE on the first column where the trigger refuses UPDATE: Postgres needs it for
  `SELECT … FOR UPDATE`, and the trigger still refuses the update), and SELECT, INSERT, UPDATE and
  DELETE on the rest (never TRUNCATE). An append-only trigger's function must be named
  `<something>_reject_change`. `app-role.test.ts` fails on any table whose grants don't match,
  and locks every table as the role. The role can't make temporary tables: guard triggers name
  their tables without a schema.
- Backward-compatible changes: expand, migrate, contract (RES-011).
- The database guards the data: NOT NULL, CHECK, foreign keys and unique constraints
  (requisition dedupe, idempotency keys) in the schema, not only in TypeScript.
- Every row belongs to a `candidate_id` (Q-02: single tenant now, no shortcuts).
- Approval records and events are append-only.
- Queries use parameters, never string-built SQL.
- Tests only touch databases whose name ends in `_test`. Unit tests use `createTestDb()` (in-process
  PGlite with every migration applied), never a server.
- Application status changes go through `transitionApplication` only, so each one writes its event.
  A move to `submitted` must pass `submittedVia` (INB-007, NS-188); new applications are created
  only through `createApplication`, which records `startedBy`. Origin lives in those events:
  email matching never writes either.
- Jobs (NS-114) are written through `job-write.ts` only: `saveIngestedJob` (create, merge as a new
  `job_source`, or unchanged) and `setJobField` (Paul's edits). A job missing a title or company is
  a `draft`; a check refuses a `ready` one without them. Job events carry ids, counts and methods,
  never a title, company or URL.
- The watchlist (NS-115, ADR-0015) is `company_watch`, written only through `watch-write.ts`. It
  holds the scheduling state (`next_poll_at`, failures, status); `packages/sources` decides
  backoff and quarantine. Its events carry the ATS kind, tier and counts, never a board name.
- Search preferences and fit scores (NS-116) are `search_preference` (one row per version; the
  current one is the highest version) and `fit_score` (unique per job, preference version, resume
  import and job fingerprint), written only through `fit-write.ts` (`fit-schema.ts`), which only
  inserts: rows are never edited, by that convention (no trigger guards them). `packages/sources`
  decides the score. Their events (`preferences.changed`, `preferences.rescored`, `job.scored`)
  carry ids, versions, numbers, bands, reason codes, flags and field names, never a preference
  value, title, requirement or atom text. `method` is `rules`, or `rules_model` when a
  model-proposed match that passed its provenance check was used (NS-138); such a match keeps
  its short verbatim atom quote and a prompt/model stamp in `evidence`, never in an event.
- Fresh-job alerts (NS-163) have no table: each is one `domain_event` (`job.fresh_alert`,
  `job.fresh_alert_held`) keyed `<type>:<jobId>`, written only through `alert-write.ts`, so a job
  is alerted and held at most once. They carry the job id, score, age, tier and a held flag,
  never a title, company or URL. `readAlertCandidates` (NS-199) reads only jobs that could still
  alert, fresh after the caller's `freshSince` (`coalesce(posted_at, first_seen_at)`, the age
  rule) or held and not yet sent; the window's length stays in `packages/sources`.
  Paul's alert settings (NS-199 slice 2) are `alert_setting`, append-only (a trigger), written
  only through `alert-setting-write.ts`; the newest row is current, a null field means the
  `ALERT_*` default, and the same values store nothing. Its CHECKs are NULL-safe (a CHECK that
  evaluates to NULL passes). `alerts.settings_changed` carries field names only, never a time zone
  (it says where Paul lives).
  The mail poll's cursor (NS-247 slice 2) is `mail_poll_cursor`, append-only, written only through
  `mail-poll-write.ts`: the newest row is current, `since` never moves backwards, and it holds no
  message id, address or subject.
  A company's own mail domains (NS-252) are `company_domain`, append-only (a trigger), written
  only through `company-domain-write.ts`: per company and domain the newest row (`add` or
  `remove`) is current, the source is `paul` (a CHECK), and its composite foreign key keeps the
  company the candidate's own. Never store a domain learned from mail, a job page or ATS metadata
  without Paul's acceptance, and never put a domain in an event or span.
- The Approval Gate's records (NS-119, ADR-0017) are `approval_request`, `approval_policy_set`,
  `approval_decision`, `approval_undo` and (NS-140) `approval_withdrawal`: append-only
  (triggers), written only through `approval-write.ts` (`requestOfDecision`, NS-211, is its read-only
  decision-to-request lookup for gateways). A withdrawn request is closed: every
  "open", "pending" or "live" check must also exclude it, in SQL (migration 0037) and in code. A
  withdrawal is by `user` (`paul`), `gateway` (`content_changed`) or, since NS-239, `system`
  (`posting_closed`, an `application_package` request only; migrations 0080–0081). Reject reasons and draft text never go into events or spans. Every Gate
  time comes from `northstar_gate_now()`, and Gate functions take no time from their caller; never
  override it outside the PGlite test setup (`src/test/global-setup.ts`). Gate transactions stay
  READ COMMITTED.
- The answer bank (GH-59) is `bank_answer`, `bank_answer_citation` and `bank_answer_use`:
  append-only (a trigger refuses UPDATE, DELETE and TRUNCATE), written only through
  `answer-write.ts`. An answer is stored only with a live Gate approval by Paul (kind `answer`,
  subject `answer:<id>`, `answerContentSha256`). The answer text is Paul's words: never copy it
  into events, spans, logs or fixtures.
- Resilience state (NS-126, ADR-0007) is `dependency_breaker` (one row per dependency, written
  only through `breaker-write.ts`) and `kill_switch` (append-only, written only through
  `kill-switch-write.ts`; the newest row per subsystem is its state, no row means on). Breaker
  events are written only on a change of state and carry the dependency, counts and an error name,
  never a message or URL.
- Dead letters (NS-175, RES-007) are `dead_letter` and `dead_letter_resolution`, append-only
  (triggers), written only through `dead-letter-write.ts`. They hold a kind, a subject id, a
  reason code and an attempt count: never a payload, error message, URL or text (CHECKs enforce
  the shapes). A producer passes its own idempotency key; one resolution per letter. The kind is a
  constant from `DEAD_LETTER_KINDS` (NS-236), never built from data; a new producer adds its kind
  there, with its words in `apps/web/src/dead-letters.ts`.
- Profile settings (NS-141, ANS-001) are `profile_setting`, append-only (a trigger), written only
  through `settings-write.ts`; the newest row per field and qualifier (case-insensitive) is the
  value. Its field list and keyed fields duplicate `FACTUAL_FIELDS` in `packages/profile` (a test
  there checks they agree). Values and qualifiers are Paul's data: `profile.setting_set` carries
  the field and a qualified flag, `answer.factual_used` the canonical id, kind, field and
  confidence, never a value, qualifier or question text.
- Paul's contact details (NS-227 slice 3) are `profile_contact`, append-only (a trigger), written
  only through `contact-write.ts`; the newest row is current and the same details store nothing.
  `setContact` checks them with `ContactDetails` (`packages/domain`) and the CHECKs' bounds before
  insert, refusing by field name. Names, email and phone are Paul's data: `profile.contact_set`
  carries the row id and a phone flag only.
- Tailored resumes (NS-146) are `tailored_resume`, one row per version per job, append-only (a
  trigger), written only through `tailor-write.ts`; `readTailorInput` reads the current resume
  import (`kind = 'resume'`) and a ready job. The stored resume, validation and score hold Paul's
  lines and the job's requirements: `resume.tailored` carries ids, counts and flags only.
- Resume audits (NS-190) are `resume_audit`, `resume_audit_suggestion`, `resume_audit_decision`
  (one per suggestion of a run; accepted with a line or rejected) and `atom_line_edit` (Paul's
  line for an atom, from an accepted decision; the newest is the atom's current line),
  append-only (triggers), written only through `audit-write.ts`. `experience_atom.source_quote`
  never changes: `readResumeMaster` (the tailor's and the audit's reader) puts the newest edit in
  its place. Callers run `applySuggestion` (`packages/profile`, CPG-004: no other role's
  employer, title or years) before `decideSuggestion`, which checks only one non-empty line (a
  CHECK refuses control characters). Lines, messages and targets stay in the tables:
  `resume.audited` and `resume.suggestion_decided` carry ids, counts, the kind and the decision
  only.
- Posting liveness (NS-173) is `posting_check`, append-only (a trigger), written only through
  `liveness-write.ts`: one row per attempt (`open`, `closed` or `unavailable`). A job is closed
  only when its two newest answers (unavailable skipped) are `closed`; `readScorableJobs` leaves
  closed jobs out. `job.closed` / `job.reopened` carry the job id and ATS, never a URL or title.
- Job forms (NS-227) are `job_form`, append-only (a trigger), written only through
  `job-form-write.ts`: a new row whenever a job's form differs from its newest one (compared by
  the questions' canonical SHA-256 under a lock on the job row), the newest current. Labels and
  choices are the employer's text, bounded before insert (200 fields, 1,000 characters per text,
  500 choices); `job.form_read` carries the job id, ATS and a count only.
- A package's inputs (NS-227 slice 5) are read only through `readPackageInputs`
  (`package-read.ts`, read-only, the candidate's own application). `formSeenBefore` counts only an
  Apply Gateway submission (`apply_submission` finished `submitted`) of another job whose form, as
  read before that submission started, had the same ATS and SHA-256; Paul's own submissions have
  no ledger row and never count. `recordPackageNeedsHuman` (`package-write.ts`) writes
  `package.needs_human` (never an `application.*` type: the feed reads those as status moves) with
  the application id, snake_case reason codes and counts only, keyed by the caller's SHA-256 basis
  so the same inputs record it once. `readPackageRounds` (slice 6) counts the application's
  package rounds from its own `application:<id>:package:<packageId>:package_ready` move keys
  (read-only) and gives the newest round's package id.
  An application package goes to the Gate through `requestPackageApproval`
  (`package-approval.ts`, NS-213), which derives its facts from storage (`readPackageInputs`) and
  verifies each bank claim against the newest banked text (a `{company}` slot only with an
  `isSafeCompany` name); the package must name the job's own posting, contact and newest tailored
  PDF. New package producers use it, never `requestApproval` with their own facts. The question a
  verified answer belongs to is still the producer's claim.
- Stored packages (NS-192) are `application_package`, one per `application_package` Gate
  request, append-only (a trigger), written only by `requestPackageApproval` in the same
  transaction as the request (a replay stores nothing). Its foreign key names the request's id,
  candidate, kind and content hash, as `reply_draft`'s does. The package holds Paul's contact
  details and answers: read it only through `readHandoffPackage`, which re-verifies the approval
  and the hash, or (NS-242) `readDecisionPackage`, the submission activity's reader, which checks
  the hash and application it is given and leaves the approval to the Apply Gateway; never copy it
  into an event, span, log or error.
- Stored files (NS-227, slice 2) are `stored_file`, append-only (a trigger), one row per candidate
  and SHA-256, written only through `file-write.ts` (`storeFileIn`, inside the caller's
  transaction; today only `saveTailoredResume`). CHECKs make the hash the bytes' own
  (`sha256(bytes)`), the type `application/pdf` and the size 1 byte to 5 MiB. A new
  `tailored_resume` version names its PDF in `pdf_sha256` (a foreign key; null on older versions).
  The bytes are Paul's resume: events carry the hash and size only. `readStoredFile` serves the
  Apply Gateway's `readFile`.
- LLM spend (NS-176, ADR-0021) is `llm_spend`, append-only (a trigger), written only through
  `spend-write.ts`: a route name and micro-dollars per reply, never a prompt, input or output.
  `readLlmSpend` sums by the UTC day and month.
- One agent at a time changes this package's schema or migrations (ADR-0016): parallel agents
  renumbering migrations caused replacement PRs. Before adding a migration, merge the latest
  `main` and generate it then.
- The feed and health views (NS-125) are read-only: `readFeed` (`feed-read.ts`) and
  `readSystemHealth` (`health-read.ts`). Feed text comes only from `feedLine` in
  `packages/domain`, which shows shape-checked payload fields and, for types without a template,
  the event's `reason`. So keep `reason` a plain sentence with no names, ids, URLs or secrets, and
  give a new event type a template in `feed.ts`, or (like the fresh-job alerts, NS-163) a
  `reason` built only from numbers and fixed words.
  Names (NS-189) are read at display time only: `readFeedNames` maps `job:<id>` and
  `application:<id>` aggregates to the candidate's own job title and company. Never copy them
  into an event, a `reason` or a span (its span carries a count only).
  The run inspector (NS-154) is `readRun` (`run-read.ts`), read-only: one candidate's events
  with the same `traceId`, lines from `feedLine`, and `payload.call` copied field by field
  (`pickCall`), never spread. Write an LLM call into an event only as the gateway's `CallRecord`.
- The submission ledger (NS-120) is `apply_submission` and `submission_proof`, written only
  through `apply-write.ts`. A trigger lets a submission row finish only once, and proof is
  append-only. `listStaleClaims` reads the claims in progress past `CLAIM_STALE_AFTER_MS` by the
  database clock, and `listHalfClosedClaims` (NS-177) the `outcome_unknown` rows whose
  application is still `awaiting_approval` or `submitting`. A composite foreign key keeps a
  row's application within its candidate; `claimSubmission` takes its cap and gap only as `ApplyLimits`
  (`apply-config.ts`). Its events carry ids, the ATS and reason codes, never field values, URLs
  or HTML.
  `@northstar/db/testing` exports the PGlite test helpers to other packages' tests.
- The credential vault (NS-122, ADR-0010) is `vault_secret` and `vault_access`, append-only
  (triggers), written only through `vault-write.ts`. It holds sealed bytes only: never put a
  plaintext, key or sealed byte in an event, span, log or error. `openSealedSecret` checks the
  `vault` kill switch and that the decision is a live approval, and records the access, in the
  same transaction before handing a row out. Only `vaultAccess` is exported; sealed rows never
  leave `vault-write.ts`.
  Since NS-182 (ADR-0024) Paul's reveal is `revealSealedSecret` only: one transaction that
  files a `vault_reveal` (by `system`), approves it for Paul (effective at once, migration 0057)
  and records one access by `user` for `reveal_to_user`. Never request, list or decide a
  `vault_reveal` anywhere else; `openSealedSecret` refuses that actor, purpose and kind, and the
  database pairs `user` with `reveal_to_user` only and lets a reveal decision open once. Since
  NS-246 (migration 0095) the database also ties a reveal decision to `reveal_to_user` and
  `reveal_to_user` to a reveal decision, and refuses any withdrawal of a reveal.
- The positioning thesis (NS-127, stored since NS-155) is `positioning_thesis` and
  `positioning_thesis_atom`, append-only (a trigger), each version citing at least one atom (a
  deferred trigger), written only through `thesis-write.ts`, which also requires the atoms to be
  from the current resume import (in code, not in the database). The text
  is Paul's words: its `thesis.approved` event carries the version and atom count only, never the
  text. Callers run `checkThesis` (`packages/profile`) before saving.
- Independent work (NS-196, DX-010) is `independent_work_set` (a version per stored file, with
  its SHA-256), `independent_work_entry` and `independent_work_line`, append-only (triggers),
  written only through `independent-work-write.ts`; the newest version is current and the same
  content stores nothing. Titles, lines and links are Paul's words: `independent_work.set`
  carries the version and counts only.
  Since NS-231 slice 5 (migration 0092) CHECKs added `NOT VALID` refuse the invisible characters
  `parseIndependentWork` refuses, listed by code point (Postgres regexes have no `\p{Cf}`); a test
  in `packages/profile` (`independent-work-db.test.ts`) checks they cover every one the parser's
  `INVISIBLE_IN_WORK` matches, so a change to that pattern needs a new migration.
- Growth (NS-210, GRW-001…004) is `growth_track_set` and `growth_track` (a version per tracks
  file), `growth_touch`, `growth_settings` (newest wins) and `growth_plan` (one per Monday-start
  week), append-only (triggers), written only through `growth-write.ts`. Track keys, names and
  next actions are Paul's words: `growth.tracks_set`, `growth.touched` and `growth.planned` carry
  versions, counts, row ids and the week only.
  Since NS-214 also `growth_check_in` (one per candidate and client idempotency key; minutes and
  an optional percent, never free text) and `growth_review` (one per Monday-start week, track keys
  and minutes), append-only, through `growth-write.ts` (`recordCheckIn`, `readCheckIns`,
  `saveWeekReview`, `readWeekReview`, `readWeekPlan`). A track's last touch is its newest touch or
  check-in. `growth.checked_in` carries the row id and minutes, `growth.reviewed` the id, week and
  two counts.
  Since NS-232 also each track's `goal` and `done_when` (nullable; 1–300 characters, no control
  characters) and append-only `growth_milestone` (per track row: position 0–19, title, optional
  `done_on`; the same-candidate foreign key), stored with the version in one transaction. The
  version's hash covers them only when given, so an older file isn't stored again. They are
  Paul's words: no event, span or error carries them.
- Reply drafts (NS-237) are `reply_draft`, one per Gate request (`email_reply`), append-only (a
  trigger), written only through `reply-write.ts` (`fileReplyDraft`: `requestApproval` and the
  insert in one transaction; `readReplyDraft`). Its foreign key names the request's id, candidate,
  kind and content hash (`approval_request_id_kind_content_unique`). It holds the recipient address, subject, thread headers
  and body Paul approves (CHECKs refuse control characters in headers), plus cites and follow-ups.
  The body and recipient never go into an event or span: `approval.requested` is the feed line.
  Paul's edits (NS-203) go only through `editReplyDraft`, which stores the new draft behind the
  request `editRequest` files. `approval_edit` (append-only, one row per old and per new request,
  both the candidate's) links an edited request to the one it replaced; a trigger checks Paul
  withdrew the old one and that both share kind and subject. Write it only through `editRequest`.
  The Gmail draft writer's ledger (NS-237 slice 6) is `reply_draft_claim` (one row per attempt,
  candidate and decision) and `reply_draft_record` (one per decision), append-only (triggers),
  written only through `reply-ledger-write.ts` (`claimDraft` under a per-decision advisory lock;
  `recordDraft`, which refuses a different second id). Ids and times only; `reply.draft_created`
  carries the decision and draft message ids, and its feed line is a fixed-word `reason`.
  `readNudgeCandidates` (`nudge-read.ts`, NS-237 slice 3) is the follow-up nudge check's
  read-only reader: applications in a nudge stage, their last move, newest linked message from a
  verified sender and whether a `reply_draft` is filed for it; ids and times only.
- Mail tags and links (NS-158) are `mail_tag` (one tag per application or tenant, never reused)
  and `mail_link` (one decision per Gmail message: linked by a step, or queued with a reason),
  append-only, written only through `mail-link-write.ts`. They hold Gmail ids, tags, steps and
  reasons: never an address, subject, sender or body. A link never changes an application's
  status; `sender_verified` is what a later automatic change must require (INB-011).
  Recruiter grades (NS-238) are `recruiter_grade`, append-only (a trigger), one per candidate and
  Gmail message (`recordRecruiterGrade` checks the message's `mail_link` first), written only through
  `recruiter-grade-write.ts` (`recordRecruiterGrade`, `readRecruiterGrades`). A CHECK keeps the
  reasons to the fixed list `RECRUITER_GRADE_REASONS` (`packages/domain`), never email text; `recruiter.graded`
  carries the message id, grade, confidence and reasons, and its feed line is its fixed-word
  `reason`.
  Mail classifications (NS-261) are `mail_classification`, append-only (a trigger), one per
  candidate and Gmail message (`recordMailClassification` checks the message's `mail_link` first,
  not a foreign key, as for `recruiter_grade`), written only through
  `mail-classification-write.ts`. CHECKs keep the kind, stage signal and review reason to their
  fixed lists and the shape consistent; never store the classification's company, role or
  requisition, a subject or an address.
  `readLinkCandidates` (NS-223) is their read-only candidates reader: applications not in a
  terminal status, with their creation time and the job's and sources' ATS names, never a name or
  address.
- Detected interviews (NS-240 slice 2, CAL-002) are `interview_detection` (one row per candidate,
  calendar event id, application and version, 1–10 by a CHECK; the highest version is current;
  writers lock the candidate row first; at most 50 new rows a day per candidate;
  a composite foreign key keeps the application the candidate's own) and `interview_decision` (one
  `confirmed` or `dismissed` per detection, checked in the transaction, not a foreign key),
  append-only (triggers), written only through `interview-write.ts`. Times, the format and a count
  only: never a title, description, address or name in a row, event or span. A decision never
  moves an application's status.
- Career DNA reports (NS-130 slice 4, DNA-008) are `career_dna_report`, one row per version per
  candidate (the highest is current), append-only (a trigger), written only through
  `career-dna-write.ts` (`saveCareerDnaReport` locks the candidate row and stores a version only
  when the snapshot's SHA-256 differs from the newest). A row is a snapshot of scores and cited atom
  and story ids, checked by `CareerDnaSnapshot`: never atom or story text or the report's
  sentences. `career_dna.saved` carries the row id, version and a dimension count only.
- Verification windows (NS-151) are `verification_window`, `verification_window_restart` (one
  per window), `verification_window_close` (one per window) and `verification_used_message` (one
  per candidate and Gmail id), append-only (triggers), written only through
  `verification-write.ts`. Every race is a unique constraint, and restart and close lock the
  window row first; a close refuses when the window was restarted after the caller read it
  (`seenResent`). They hold names, domains, hosts, times and Gmail ids: never a code, link,
  subject, body or sender address. Their events carry the window id, tenant, ATS, purpose and
  outcome only.
- Human handoffs (NS-121) are `apply_handoff` (one per submission a challenge stopped, with its
  https apply URL) and `apply_handoff_done` (one outcome per handoff, `submitted` or `gave_up`),
  append-only (triggers), written only through `handoff-write.ts`: `openHandoff` inside
  `recordNeedsHuman`'s transaction, `resolveHandoff` for Paul. Their events carry ids, the ATS,
  the reason and the outcome, never the URL. Since NS-192 slice 3 `recordHandoffPrefill` writes
  `handoff.prefilled` (by `user`; the application id, ATS and the package's field count, never a
  value; keyed per grant, so a replay stores nothing; its feed line is a fixed-word `reason`) for
  the candidate's own handoff and that handoff's own application.
- The tenant registry (NS-124) is `employer_tenant` (one per candidate and tenant key, never
  changed) and `tenant_account_status` (append-only; the newest row is the account's status, none
  means `none`), written only through `tenant-write.ts`. Start an account only with
  `beginAccountCreation`, which takes the tenant's row lock so one caller wins (ACC-006). Consent
  is `consent_policy` and `consent_record` (append-only, marketing refused by a CHECK), written
  only through `consent-write.ts`. Their events carry tenant keys, statuses, reason codes, the
  policy, the notice kind and its SHA-256: never the account email, a URL or a notice's text.
- Passkeys (NS-178, ADR-0022) are `passkey_credential` and `passkey_use`, append-only (triggers),
  written only through `passkey-write.ts`. A sign-in adds a use with its sign count, which must
  increase (0 may repeat, for platform passkeys); a unique index stops two uses claiming one
  non-zero count. Credential ids and public keys never go into events, spans or logs:
  `passkey.registered` carries the row id only.
- The voice profile (NS-185, ANS-007/008) is `voice_profile` (one row per version),
  `voice_review` (Paul's keep/drop per version; the newest counts) and `voice_edit` (an approved
  answer's deleted phrases only, one row per approval `subject`), append-only (triggers), written only through `voice-write.ts`.
  Never store a sample, draft or approved text. Phrases are from Paul's writing: `voice.measured`
  and `voice.reviewed` carry versions and counts only.
- The pipeline reads (NS-168, `pipeline-read.ts`) are read-only: `listApplications` and
  `readApplicationTimeline`. A timeline is the application's own events plus events whose payload
  names it (`applicationId`); its lines come only from `feedLine`. So an event about an
  application should carry `applicationId` in its payload.
  Since NS-207 `listApplications` takes an optional filter (company part, fit band, the job's
  ATS or `other`, creation days), applied as SQL parameters, and gives each row its job's newest
  fit score and band.
  `readInboxThreads` (NS-165, `inbox-read.ts`) groups `mail_link` rows by application and
  thread (counts, newest time, newest step, any verified sender) with origins from
  `readOrigins`; read-only, Gmail ids and flags only.
  `readApplicationHistories` (NS-208) gives each application's creation time, source, newest fit
  band, posting time and status moves (`application.*` events with a `to`), never names or text.
