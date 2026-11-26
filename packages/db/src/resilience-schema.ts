import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";

// Resilience state (NS-126, ADR-0007 items 3 and 6). Write it only through breaker-write.ts,
// kill-switch-write.ts and (NS-175) dead-letter-write.ts.

const candidateId = () =>
  uuid("candidate_id")
    .notNull()
    .references(() => candidate.id);

// What a dependency or subsystem name may look like: lowercase words joined by `_ . : -`
// (`anthropic`, `ats:greenhouse`, `source:lever`). Never a URL, an address or free text.
export const NAME_PATTERN = "^[a-z0-9]+([_.:-][a-z0-9]+)*$";

// The subsystems a kill switch can name (RES-008): the fixed ones, or a source, adapter or agent.
export const SUBSYSTEM_PATTERN =
  "^(auto_apply|outreach_send|inbox_auto_label|vault|(source|adapter|agent):[a-z0-9]+([_.-][a-z0-9]+)*)$";

// One circuit breaker per candidate and dependency (RES-002). The state machine is in
// packages/domain (breaker.ts); this row is its stored state, locked while it changes.
export const dependencyBreaker = pgTable(
  "dependency_breaker",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateId(),
    dependency: text("dependency").notNull(),
    status: text("status").notNull(),
    consecutiveFailures: integer("consecutive_failures").notNull(),
    opens: integer("opens").notNull(),
    retryAt: timestamp("retry_at", { withTimezone: true }),
    // An error name only (TimeoutError, RateLimited), never a message.
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("dependency_breaker_one_per_dependency").on(t.candidateId, t.dependency),
    check(
      "dependency_breaker_dependency_format",
      sql`${t.dependency} ~ ${sql.raw(`'${NAME_PATTERN}'`)}`,
    ),
    check("dependency_breaker_status_valid", sql`${t.status} in ('closed', 'open', 'half_open')`),
    // Closed has no retry time; open and half_open always have one.
    check(
      "dependency_breaker_retry_at_matches_status",
      sql`(${t.status} = 'closed') = (${t.retryAt} is null)`,
    ),
    check(
      "dependency_breaker_counts_nonnegative",
      sql`${t.consecutiveFailures} >= 0 and ${t.opens} >= 0`,
    ),
    check(
      "dependency_breaker_last_error_name",
      sql`${t.lastError} is null or ${t.lastError} ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'`,
    ),
  ],
);

// Kill switches (RES-008): append-only, one row per change. The newest row (highest position)
// per subsystem is its state; a subsystem with no row is on.
export const killSwitch = pgTable(
  "kill_switch",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Orders changes even when two land in the same instant.
    position: bigint("position", { mode: "bigint" }).notNull().generatedAlwaysAsIdentity(),
    candidateId: candidateId(),
    subsystem: text("subsystem").notNull(),
    enabled: boolean("enabled").notNull(),
    // Who flipped it (`user`, `system`), and Paul's reason, for the feed.
    actor: text("actor").notNull(),
    reason: text("reason").notNull(),
    setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("kill_switch_position_unique").on(t.position),
    check(
      "kill_switch_subsystem_valid",
      sql`${t.subsystem} ~ ${sql.raw(`'${SUBSYSTEM_PATTERN}'`)}`,
    ),
    check("kill_switch_actor_valid", sql`${t.actor} in ('user', 'system')`),
    check("kill_switch_reason_length", sql`length(trim(${t.reason})) between 1 and 200`),
  ],
);

// A dead letter's subject: the entity the work was about (`application:<uuid>`). Never free text.
export const DEAD_LETTER_SUBJECT_PATTERN =
  "^[a-z_]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
// A reason code (`timeout`, `rate_limited`): never a message.
export const REASON_CODE_PATTERN = "^[a-z][a-z0-9_]{0,63}$";
export const DEAD_LETTER_ACTIONS = ["retry", "skip", "hand_off"] as const;

// Work that exhausted its retries (NS-175, RES-007): append-only, one row per failure (the same
// idempotency key twice is one row). Kind, subject, reason code and attempts only: never a
// payload, message, URL or text.
export const deadLetter = pgTable(
  "dead_letter",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateId(),
    // What kind of work it was (`apply.submit`, `llm.route:story-draft`): NAME_PATTERN.
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    reasonCode: text("reason_code").notNull(),
    attempts: integer("attempts").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    deadAt: timestamp("dead_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("dead_letter_id_candidate_unique").on(t.id, t.candidateId),
    unique("dead_letter_idempotency_unique").on(t.candidateId, t.idempotencyKey),
    check(
      "dead_letter_kind_valid",
      sql`${t.kind} ~ ${sql.raw(`'${NAME_PATTERN}'`)} and length(${t.kind}) <= 64`,
    ),
    check(
      "dead_letter_subject_valid",
      sql`${t.subject} ~ ${sql.raw(`'${DEAD_LETTER_SUBJECT_PATTERN}'`)}`,
    ),
    check(
      "dead_letter_reason_valid",
      sql`${t.reasonCode} ~ ${sql.raw(`'${REASON_CODE_PATTERN}'`)}`,
    ),
    check("dead_letter_attempts_positive", sql`${t.attempts} >= 1`),
    check("dead_letter_key_length", sql`length(${t.idempotencyKey}) between 1 and 200`),
  ],
);

// What Paul (or the system) chose for a dead letter: retry, skip or hand off. Append-only, at most
// one per letter; a retry that fails again is a new letter.
export const deadLetterResolution = pgTable(
  "dead_letter_resolution",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateId(),
    deadLetterId: uuid("dead_letter_id").notNull(),
    action: text("action").notNull(),
    actor: text("actor").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("dead_letter_resolution_one_per_letter").on(t.deadLetterId),
    check("dead_letter_resolution_action_valid", sql`${t.action} in ('retry', 'skip', 'hand_off')`),
    check("dead_letter_resolution_actor_valid", sql`${t.actor} in ('user', 'system')`),
    foreignKey({
      name: "dead_letter_resolution_same_candidate_fk",
      columns: [t.deadLetterId, t.candidateId],
      foreignColumns: [deadLetter.id, deadLetter.candidateId],
    }),
  ],
);
