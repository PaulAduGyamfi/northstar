import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";

// The funnel backfill (NS-113, DX-001/002). Only ids and extracted fields are stored: never a
// subject, a body or an address (NFR-SEC-005). Funnel records are derived from these rows by plain
// code in packages/funnel, so reruns and review decisions can't leave stored records out of sync.

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const candidateId = () =>
  uuid("candidate_id")
    .notNull()
    .references(() => candidate.id);

// INB-003's message types, plus the stage a message shows.
export const MAIL_KINDS = [
  "confirmation",
  "rejection",
  "assessment",
  "interview_request",
  "scheduling",
  "recruiter_inbound",
  "follow_up_needed",
  "offer",
  "info_other",
] as const;
export const STAGE_SIGNALS = ["none", "screen", "technical", "onsite", "offer"] as const;
export const REVIEW_REASONS = [
  "refused",
  "truncated",
  "invalid_output",
  "provenance",
  "ambiguous",
  "unparseable",
] as const;
export const FUNNEL_STAGES = [
  "applied",
  "responded",
  "screen",
  "technical",
  "onsite",
  "offer",
] as const;
export const FUNNEL_OUTCOMES = ["open", "rejected", "offer", "ghosted", "withdrawn"] as const;
export const CHANNELS = ["cold", "referral", "outreach", "recruiter_inbound"] as const;

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
const DAY = "'^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'";

// One Gmail message the backfill has seen. status:
// - not_job: the pre-filter dropped it (nothing but its ids is kept);
// - classified: rules, the model or Paul placed it (kind and company are set);
// - needs_review: waiting for Paul in `funnel review` (review_reason says why);
// - discarded: Paul said it isn't part of the funnel.
export const funnelMessage = pgTable(
  "funnel_message",
  {
    id: id(),
    candidateId: candidateId(),
    gmailId: text("gmail_id").notNull(),
    threadId: text("thread_id").notNull(),
    // The sender's domain, e.g. greenhouse-mail.io; null for not_job (no personal mail kept).
    senderDomain: text("sender_domain"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    status: text("status").notNull(),
    kind: text("kind"),
    // Verbatim from the message (the provenance check), or typed by Paul in review.
    company: text("company"),
    role: text("role"),
    requisition: text("requisition"),
    stageSignal: text("stage_signal"),
    classifiedBy: text("classified_by"),
    reviewReason: text("review_reason"),
    promptVersion: integer("prompt_version"),
    model: text("model"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Each Gmail message is processed once per candidate (safe to repeat).
    unique("funnel_message_gmail_unique").on(t.candidateId, t.gmailId),
    index("funnel_message_thread").on(t.candidateId, t.threadId),
    check(
      "funnel_message_status_valid",
      sql`${t.status} in ('not_job', 'classified', 'needs_review', 'discarded')`,
    ),
    check(
      "funnel_message_kind_valid",
      sql`${t.kind} is null or ${t.kind} in (${inList(MAIL_KINDS)})`,
    ),
    check(
      "funnel_message_stage_valid",
      sql`${t.stageSignal} is null or ${t.stageSignal} in (${inList(STAGE_SIGNALS)})`,
    ),
    check(
      "funnel_message_by_valid",
      sql`${t.classifiedBy} is null or ${t.classifiedBy} in ('rules', 'model', 'paul')`,
    ),
    check(
      "funnel_message_reason_valid",
      sql`${t.reviewReason} is null or ${t.reviewReason} in (${inList(REVIEW_REASONS)})`,
    ),
    // A classified message names its kind and company; a review item says why it's waiting.
    check(
      "funnel_message_classified_complete",
      sql`${t.status} <> 'classified' or (${t.kind} is not null and ${t.company} is not null and ${t.classifiedBy} is not null)`,
    ),
    check(
      "funnel_message_review_has_reason",
      sql`${t.status} <> 'needs_review' or ${t.reviewReason} is not null`,
    ),
  ],
);

// One row of Paul's own tracker export (DX-002). An import replaces the current rows (the old ones
// are marked superseded); the same file again changes nothing. `notes` is never stored.
export const funnelManualRow = pgTable(
  "funnel_manual_row",
  {
    id: id(),
    candidateId: candidateId(),
    fileSha256: text("file_sha256").notNull(),
    line: integer("line").notNull(),
    company: text("company").notNull(),
    role: text("role").notNull(),
    appliedOn: text("applied_on").notNull(),
    stageReached: text("stage_reached").notNull(),
    outcome: text("outcome").notNull(),
    outcomeOn: text("outcome_on"),
    channel: text("channel"),
    createdAt: createdAt(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("funnel_manual_row_one_active_line")
      .on(t.candidateId, t.line)
      .where(sql`${t.supersededAt} is null`),
    check("funnel_manual_row_sha", sql`${t.fileSha256} ~ '^[0-9a-f]{64}$'`),
    check("funnel_manual_row_applied_on", sql`${t.appliedOn} ~ ${sql.raw(DAY)}`),
    check(
      "funnel_manual_row_outcome_on",
      sql`${t.outcomeOn} is null or ${t.outcomeOn} ~ ${sql.raw(DAY)}`,
    ),
    check("funnel_manual_row_stage", sql`${t.stageReached} in (${inList(FUNNEL_STAGES)})`),
    check("funnel_manual_row_outcome", sql`${t.outcome} in (${inList(FUNNEL_OUTCOMES)})`),
    check(
      "funnel_manual_row_channel",
      sql`${t.channel} is null or ${t.channel} in (${inList(CHANNELS)})`,
    ),
  ],
);
