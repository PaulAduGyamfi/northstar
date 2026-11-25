import { APPLICATION_STATUSES } from "@northstar/domain";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Only the tables the state machine and the event log need (NS-105). Every other entity in
// system-design §4 arrives with its own ticket.

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// Single tenant today, but every row still names its candidate (Q-02, .claude/rules/db.md).
export const candidate = pgTable("candidate", {
  id: id(),
  displayName: text("display_name").notNull(),
  createdAt: createdAt(),
});

export const company = pgTable(
  "company",
  {
    id: id(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  // Target of the composite foreign key below: a job can only point at its own candidate's company.
  (t) => [unique("company_id_candidate_unique").on(t.id, t.candidateId)],
);

// The ATSs Northstar reads job postings from (NS-114). A constant, so sql.raw builds no SQL from
// input.
export const ATS_KINDS = [
  "greenhouse",
  "lever",
  "ashby",
  "workday",
  "smartrecruiters",
  "workable",
] as const;
const atsList = sql.raw(ATS_KINDS.map((a) => `'${a}'`).join(", "));

export const job = pgTable(
  "job",
  {
    id: id(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    // Nullable for a draft (NS-114): extraction may not find them; a check requires both once ready.
    companyId: uuid("company_id"),
    title: text("title"),
    // The canonical URL of the first source (tracking parameters removed).
    url: text("url").notNull(),
    createdAt: createdAt(),
    // NS-114 (SRC-001, SRC-009). A draft lists the fields extraction couldn't find.
    status: text("status").notNull().default("ready"),
    missingFields: text("missing_fields").array().notNull().default(sql`'{}'::text[]`),
    location: text("location"),
    remote: text("remote"),
    salaryMin: integer("salary_min"),
    salaryMax: integer("salary_max"),
    salaryCurrency: text("salary_currency"),
    salaryPeriod: text("salary_period"),
    seniority: text("seniority"),
    requirements: text("requirements").array().notNull().default(sql`'{}'::text[]`),
    niceToHaves: text("nice_to_haves").array().notNull().default(sql`'{}'::text[]`),
    applyUrl: text("apply_url"),
    ats: text("ats"),
    // The posting's public description (not personal data); used for dedupe and later scoring.
    description: text("description"),
    // When the source says it was posted, and when Northstar first saw it (freshness, SRC-009).
    postedAt: timestamp("posted_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("job_id_candidate_unique").on(t.id, t.candidateId),
    foreignKey({
      name: "job_company_same_candidate_fk",
      columns: [t.companyId, t.candidateId],
      foreignColumns: [company.id, company.candidateId],
    }),
    check("job_status_valid", sql`${t.status} in ('draft', 'ready')`),
    // A ready job always has a title and a company; only a draft may lack them.
    check(
      "job_ready_complete",
      sql`${t.status} <> 'ready' or (${t.companyId} is not null and ${t.title} is not null and length(trim(${t.title})) > 0)`,
    ),
    check(
      "job_remote_valid",
      sql`${t.remote} is null or ${t.remote} in ('onsite', 'hybrid', 'remote')`,
    ),
    check(
      "job_salary_order",
      sql`${t.salaryMin} is null or ${t.salaryMax} is null or ${t.salaryMin} <= ${t.salaryMax}`,
    ),
    check(
      "job_salary_period_valid",
      sql`${t.salaryPeriod} is null or ${t.salaryPeriod} in ('year', 'month', 'hour')`,
    ),
    check("job_ats_valid", sql`${t.ats} is null or ${t.ats} in (${atsList})`),
    // Shown as a link later: http(s) only, never javascript: or data:.
    check("job_url_http", sql`${t.url} ~ '^https?://'`),
    check("job_apply_url_http", sql`${t.applyUrl} is null or ${t.applyUrl} ~ '^https?://'`),
  ],
);

// Every place a job was seen (SRC-006): the same role from two sources is one job with two rows
// here. Adding the same URL twice changes nothing (unique on the canonical URL).
export const jobSource = pgTable(
  "job_source",
  {
    id: id(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    jobId: uuid("job_id").notNull(),
    url: text("url").notNull(),
    // How the job's fields were read from this source.
    method: text("method").notNull(),
    ats: text("ats"),
    // The ATS's own id for the posting, the most reliable duplicate key.
    atsPostingId: text("ats_posting_id"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "job_source_job_same_candidate_fk",
      columns: [t.jobId, t.candidateId],
      foreignColumns: [job.id, job.candidateId],
    }),
    unique("job_source_url_unique").on(t.candidateId, t.url),
    uniqueIndex("job_source_ats_posting_unique")
      .on(t.candidateId, t.ats, t.atsPostingId)
      .where(sql`${t.atsPostingId} is not null`),
    check("job_source_method_valid", sql`${t.method} in ('ats_api', 'jsonld', 'model', 'text')`),
    check("job_source_ats_valid", sql`${t.ats} is null or ${t.ats} in (${atsList})`),
    check("job_source_url_http", sql`${t.url} ~ '^https?://'`),
  ],
);

// The status list is a constant from @northstar/domain, so sql.raw builds no SQL from input.
const statusList = sql.raw(APPLICATION_STATUSES.map((s) => `'${s}'`).join(", "));

export const application = pgTable(
  "application",
  {
    id: id(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    jobId: uuid("job_id").notNull(),
    status: text("status").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The database refuses a status the state machine doesn't know, not only TypeScript.
    check("application_status_valid", sql`${t.status} in (${statusList})`),
    // One application per job (the base of APPLY-009: never apply to the same job twice).
    unique("application_one_per_job").on(t.candidateId, t.jobId),
    foreignKey({
      name: "application_job_same_candidate_fk",
      columns: [t.jobId, t.candidateId],
      foreignColumns: [job.id, job.candidateId],
    }),
  ],
);

// The append-only event log (ADR-0012). A trigger in a custom migration rejects UPDATE and DELETE.
export const domainEvent = pgTable(
  "domain_event",
  {
    id: uuid("id").primaryKey(),
    // Readers keep a cursor on this ever-increasing number instead of flagging rows.
    position: bigint("position", { mode: "bigint" }).notNull().generatedAlwaysAsIdentity(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    aggregate: text("aggregate").notNull(),
    type: text("type").notNull(),
    actor: text("actor").notNull(),
    reason: text("reason").notNull(),
    inputsSummary: text("inputs_summary").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    links: jsonb("links").$type<{ rel: string; href: string }[]>().notNull(),
    traceId: text("trace_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    // A retry with the same key can never write a second event (RES-006).
    unique("domain_event_idempotency_unique").on(t.candidateId, t.idempotencyKey),
    unique("domain_event_position_unique").on(t.position),
    check(
      "domain_event_trace_id_format",
      sql`${t.traceId} is null or ${t.traceId} ~ '^[0-9a-f]{32}$'`,
    ),
  ],
);

// The company job boards Paul watches (NS-115, SRC-003). Scheduling state lives here (ADR-0015):
// any process can run a poll pass, and restarting loses nothing.
export const WATCH_STATUSES = ["ok", "backing_off", "quarantined"] as const;
const watchStatusList = sql.raw(WATCH_STATUSES.map((s) => `'${s}'`).join(", "));

export const companyWatch = pgTable(
  "company_watch",
  {
    id: id(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    ats: text("ats").notNull(),
    // The board's id at its ATS (Greenhouse board token, Lever company, Ashby org, ...).
    board: text("board").notNull(),
    // The board's own URL as Paul gave it, canonical.
    url: text("url").notNull(),
    // 1 dream, 2 target, 3 long tail: sets the cadence (SRC-012).
    tier: integer("tier").notNull(),
    status: text("status").notNull().default("ok"),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }).notNull().defaultNow(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    // The last failure's error name only (FetchRefused, TimeoutError...), never a message.
    lastError: text("last_error"),
    jobsFound: integer("jobs_found").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    unique("company_watch_board_unique").on(t.candidateId, t.ats, t.board),
    check("company_watch_ats_valid", sql`${t.ats} in (${atsList})`),
    check("company_watch_tier_valid", sql`${t.tier} in (1, 2, 3)`),
    check("company_watch_status_valid", sql`${t.status} in (${watchStatusList})`),
    check("company_watch_failures_nonnegative", sql`${t.consecutiveFailures} >= 0`),
    check("company_watch_url_https", sql`${t.url} ~ '^https://'`),
  ],
);
