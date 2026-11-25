import { APPROVAL_KINDS, type PackageFacts, type PolicyRule } from "@northstar/domain";
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
import { candidate } from "./schema.js";

// The Approval Gate's records (NS-119, ADR-0002, ADR-0017). All four tables are append-only: a
// trigger in a custom migration refuses UPDATE, DELETE and TRUNCATE (APR-004). The state of a
// request is derived from them: pending while it has no live decision (one with no undo).
// Write them only through approval-write.ts.

// A constant from @northstar/domain, so sql.raw builds no SQL from input.
const kindList = sql.raw(APPROVAL_KINDS.map((k) => `'${k}'`).join(", "));

// Something waiting for Paul (APR-001). The subject is what it would let out, as an aggregate.
export const approvalRequest = pgTable(
  "approval_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    kind: text("kind").notNull(),
    // `<kind>:<uuid>`, e.g. `application:…`; the same format as domain_event.aggregate.
    subject: text("subject").notNull(),
    // The facts a policy may look at (numbers and flags only); null when the kind has none.
    facts: jsonb("facts").$type<PackageFacts>(),
    // Who asked (`agent:apply`, `system`), for the feed and the audit trail.
    actor: text("actor").notNull(),
    // A retried request with the same key is the same request (RES-006).
    idempotencyKey: text("idempotency_key").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("approval_request_id_candidate_unique").on(t.id, t.candidateId),
    unique("approval_request_idempotency_unique").on(t.candidateId, t.idempotencyKey),
    check("approval_request_kind_valid", sql`${t.kind} in (${kindList})`),
    check(
      "approval_request_subject_format",
      sql`${t.subject} ~ '^[a-z_]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
  ],
);

// Paul's auto-approve rules, saved as a whole set. The newest set (highest version) is the one in
// force; older sets stay so every policy decision can show the exact rules it used.
export const approvalPolicySet = pgTable(
  "approval_policy_set",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Ever-increasing, so "newest" never depends on two rows sharing a timestamp.
    version: bigint("version", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    // Checked by parsePolicySet before it is stored; an empty array means "everything waits".
    rules: jsonb("rules").$type<PolicyRule[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("approval_policy_set_id_candidate_unique").on(t.id, t.candidateId),
    check("approval_policy_set_rules_array", sql`jsonb_typeof(${t.rules}) = 'array'`),
  ],
);

// A decision on a request: Paul's, or a policy's. Its id is the `approvalId` (decided by Paul) or
// `policyDecisionId` (decided by a policy) a gateway carries (ADR-0002 item 3).
export const approvalDecision = pgTable(
  "approval_decision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    requestId: uuid("request_id").notNull(),
    decision: text("decision").notNull(),
    decidedBy: text("decided_by").notNull(),
    // Set only when a policy decided: which set and which rule in it.
    policySetId: uuid("policy_set_id"),
    ruleName: text("rule_name"),
    // Paul's reason for a rejection (APR-002). Kept here only: never copied into events or spans.
    reason: text("reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    // When the decision takes effect; until then it can be undone (the undo window).
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("approval_decision_id_candidate_unique").on(t.id, t.candidateId),
    foreignKey({
      name: "approval_decision_request_same_candidate_fk",
      columns: [t.requestId, t.candidateId],
      foreignColumns: [approvalRequest.id, approvalRequest.candidateId],
    }),
    foreignKey({
      name: "approval_decision_policy_set_same_candidate_fk",
      columns: [t.policySetId, t.candidateId],
      foreignColumns: [approvalPolicySet.id, approvalPolicySet.candidateId],
    }),
    check("approval_decision_decision_valid", sql`${t.decision} in ('approved', 'rejected')`),
    check("approval_decision_decided_by_valid", sql`${t.decidedBy} in ('user', 'policy')`),
    // A policy only ever approves, and always names its set and rule; Paul's decisions name none.
    check(
      "approval_decision_policy_fields",
      sql`(${t.decidedBy} = 'policy' and ${t.decision} = 'approved' and ${t.policySetId} is not null and ${t.ruleName} is not null)
        or (${t.decidedBy} = 'user' and ${t.policySetId} is null and ${t.ruleName} is null)`,
    ),
    // A rejection always says why (APR-002: the reason feeds learning).
    check(
      "approval_decision_reject_has_reason",
      sql`${t.decision} <> 'rejected' or (${t.reason} is not null and length(trim(${t.reason})) > 0)`,
    ),
    check("approval_decision_effective_after_decided", sql`${t.effectiveAt} >= ${t.decidedAt}`),
  ],
);

// Paul took a decision back inside its undo window. One undo per decision; the request is pending
// again and may get a new decision.
export const approvalUndo = pgTable(
  "approval_undo",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    decisionId: uuid("decision_id").notNull(),
    undoneAt: timestamp("undone_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("approval_undo_one_per_decision").on(t.decisionId),
    foreignKey({
      name: "approval_undo_decision_same_candidate_fk",
      columns: [t.decisionId, t.candidateId],
      foreignColumns: [approvalDecision.id, approvalDecision.candidateId],
    }),
  ],
);
