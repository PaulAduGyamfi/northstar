import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";

// Resilience state (NS-126, ADR-0007 items 3 and 6). Write it only through breaker-write.ts and
// kill-switch-write.ts.

const candidateId = () =>
  uuid("candidate_id")
    .notNull()
    .references(() => candidate.id);

// What a dependency or subsystem name may look like: lowercase words joined by `_ . : -`
// (`anthropic`, `ats:greenhouse`, `source:lever`). Never a URL, an address or free text.
export const NAME_PATTERN = "^[a-z0-9]+([_.:-][a-z0-9]+)*$";

// The subsystems a kill switch can name (RES-008): the fixed ones, or a source, adapter or agent.
export const SUBSYSTEM_PATTERN =
  "^(auto_apply|outreach_send|inbox_auto_label|(source|adapter|agent):[a-z0-9]+([_.-][a-z0-9]+)*)$";

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
