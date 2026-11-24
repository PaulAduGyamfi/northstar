import { APPLICATION_STATUSES } from "@northstar/domain";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
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

export const job = pgTable(
  "job",
  {
    id: id(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    companyId: uuid("company_id").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("job_id_candidate_unique").on(t.id, t.candidateId),
    foreignKey({
      name: "job_company_same_candidate_fk",
      columns: [t.companyId, t.candidateId],
      foreignColumns: [company.id, company.candidateId],
    }),
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
