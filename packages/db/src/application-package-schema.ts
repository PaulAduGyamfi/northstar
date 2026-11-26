import type { ApplicationPackage } from "@northstar/domain";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { approvalRequest } from "./approval-schema.js";
import { candidate } from "./schema.js";

// Application packages filed with the Approval Gate (NS-192, APPLY-006): one row per
// `application_package` request, holding exactly the package Paul (or a policy) approved. Before
// this, only its hash was kept. The handoff pre-fill reads it (slice 2: the extension). Append-only
// (migration trigger), written only by requestPackageApproval in the same transaction as the
// request. It holds Paul's contact details and answers: they stay in this table, never in an
// event, span or log.
export const applicationPackage = pgTable(
  "application_package",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    requestId: uuid("request_id").notNull(),
    // Always application_package: with content_sha256 it joins the foreign key, so a row can only
    // sit behind an application_package request that pins this exact content.
    requestKind: text("request_kind").notNull().default("application_package"),
    applicationId: uuid("application_id").notNull(),
    // packageSha256 (packages/domain): the hash the Gate request pins.
    contentSha256: text("content_sha256").notNull(),
    package: jsonb("package").$type<ApplicationPackage>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One package per Gate request; filing the same package again stores nothing.
    unique("application_package_request_unique").on(t.requestId),
    foreignKey({
      name: "application_package_request_same_candidate_fk",
      columns: [t.requestId, t.candidateId, t.requestKind, t.contentSha256],
      foreignColumns: [
        approvalRequest.id,
        approvalRequest.candidateId,
        approvalRequest.kind,
        approvalRequest.contentSha256,
      ],
    }),
    check("application_package_request_kind", sql`${t.requestKind} = 'application_package'`),
    check("application_package_sha256_shape", sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check("application_package_is_object", sql`jsonb_typeof(${t.package}) = 'object'`),
  ],
);
