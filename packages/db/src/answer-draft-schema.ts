import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { BANK_KINDS } from "./answer-schema.js";
import { approvalRequest } from "./approval-schema.js";
import { application, candidate } from "./schema.js";

// Answer drafts filed with the Approval Gate (NS-281 slice 3, ANS-004, ANS-005): one row per Gate
// `answer` request, holding exactly what Paul approves and `saveApprovedAnswer` later banks.
// Append-only (migration trigger), written only through answer-draft-write.ts. The texts are drafted
// from Paul's stories and atoms: they stay in this table, never in an event, span or log.

const kindList = sql.raw(BANK_KINDS.map((k) => `'${k}'`).join(", "));

export const answerDraft = pgTable(
  "answer_draft",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    requestId: uuid("request_id").notNull(),
    // Always `answer`: with content_sha256 it joins the foreign key, so a row can only sit behind
    // an `answer` request that pins this exact content.
    requestKind: text("request_kind").notNull().default("answer"),
    // The bank answer's id, chosen before the Gate was asked: the request's subject is
    // `answer:<answer_id>`, and saveApprovedAnswer stores the banked answer under it.
    answerId: uuid("answer_id").notNull(),
    // The application the answer was drafted for (ANS-006), and the form field it answers.
    applicationId: uuid("application_id").notNull(),
    fieldName: text("field_name").notNull(),
    canonicalId: text("canonical_id").notNull(),
    kind: text("kind").notNull(),
    shortText: text("short_text").notNull(),
    longText: text("long_text"),
    // The matcher's confidence for the form question (NS-118), for the bank's feed line only.
    confidence: real("confidence").notNull(),
    // The story and atom ids the draft cites (validateAnswerDraft checked each quote).
    storyIds: jsonb("story_ids").$type<string[]>().notNull(),
    atomIds: jsonb("atom_ids").$type<string[]>().notNull(),
    // answerContentSha256: the hash the Gate request pins.
    contentSha256: text("content_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One draft per Gate request, and one per bank answer id.
    unique("answer_draft_request_unique").on(t.requestId),
    unique("answer_draft_answer_unique").on(t.candidateId, t.answerId),
    foreignKey({
      name: "answer_draft_request_same_candidate_fk",
      columns: [t.requestId, t.candidateId, t.requestKind, t.contentSha256],
      foreignColumns: [
        approvalRequest.id,
        approvalRequest.candidateId,
        approvalRequest.kind,
        approvalRequest.contentSha256,
      ],
    }),
    // The application is the candidate's own.
    foreignKey({
      name: "answer_draft_application_same_candidate_fk",
      columns: [t.applicationId, t.candidateId],
      foreignColumns: [application.id, application.candidateId],
    }),
    check("answer_draft_request_kind", sql`${t.requestKind} = 'answer'`),
    check("answer_draft_kind", sql`${t.kind} in (${kindList})`),
    check("answer_draft_canonical_shape", sql`${t.canonicalId} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check(
      "answer_draft_field_shape",
      sql`char_length(${t.fieldName}) between 1 and 200 and ${t.fieldName} !~ '[[:cntrl:]]'`,
    ),
    check("answer_draft_confidence_range", sql`${t.confidence} between 0 and 1`),
    check("answer_draft_sha256_shape", sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "answer_draft_text_shape",
      sql`char_length(${t.shortText}) between 1 and 5000 and (${t.longText} is null or char_length(${t.longText}) between 1 and 10000)`,
    ),
    check(
      "answer_draft_lists_shape",
      sql`jsonb_typeof(${t.storyIds}) = 'array' and jsonb_typeof(${t.atomIds}) = 'array'`,
    ),
  ],
);
