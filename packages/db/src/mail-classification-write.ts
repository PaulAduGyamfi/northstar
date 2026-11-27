import type { CandidateId, Result } from "@northstar/domain";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db.js";
import { MAIL_KINDS, STAGE_SIGNALS } from "./funnel-schema.js";
import { CLASSIFICATION_REVIEW_REASONS, mailClassification } from "./mail-classification-schema.js";
import { mailLink } from "./mail-link-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";

// Recording a linked message's classification (NS-261, INB-003/012): what classifyLinkedMail
// (@northstar/inbox) decided, stored once per message with its feed event in one transaction.
// Codes only: the classification's company, role and requisition never reach the table, the event
// or the span, so a caller passes only these fields.

const PromptVersion = z.number().int().min(1).max(9999);

// A classified message: a model's decision names its prompt version, a rules decision has none
// (the same rule as the table's CHECK).
const Classified = z
  .object({
    outcome: z.literal("classified"),
    kind: z.enum(MAIL_KINDS),
    stageSignal: z.enum(STAGE_SIGNALS),
    decidedBy: z.enum(["rules", "model"]),
    promptVersion: PromptVersion.optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if ((c.decidedBy === "model") !== (c.promptVersion !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["promptVersion"], message: "model decisions only" });
    }
  });

const Review = z
  .object({
    outcome: z.literal("review"),
    reason: z.enum(CLASSIFICATION_REVIEW_REASONS),
    promptVersion: PromptVersion,
  })
  .strict();

// Verification mail the classifier left alone (NS-271, INB-012): stored so the mail loop stops
// reading it again. Verification is the only reason, and nothing about the code is kept (VER-005).
const Skipped = z
  .object({
    outcome: z.literal("skipped"),
    reason: z.literal("verification"),
  })
  .strict();

export const ClassificationResult = z.discriminatedUnion("outcome", [Classified, Review, Skipped]);
export type ClassificationResult = z.infer<typeof ClassificationResult>;

// Each kind in the feed's words (fixed text, no names).
const KIND_WORDS: Record<(typeof MAIL_KINDS)[number], string> = {
  confirmation: "an application confirmation",
  rejection: "a rejection",
  assessment: "an assessment",
  interview_request: "an interview request",
  scheduling: "a scheduling email",
  recruiter_inbound: "a recruiter email",
  follow_up_needed: "a follow-up request",
  offer: "an offer",
  info_other: "an update",
};

const GMAIL_ID = /^[0-9a-f]{1,32}$/;

export type ClassificationError =
  | { kind: "InvalidClassification"; fields: string[] }
  // The mail loop never recorded this message, so there is nothing to classify.
  | { kind: "UnknownMessage" };

export async function recordMailClassification(
  db: Db,
  input: { candidateId: CandidateId; gmailMessageId: string; result: unknown },
): Promise<Result<{ recorded: boolean }, ClassificationError>> {
  const parsed = ClassificationResult.safeParse(input.result);
  const fields = parsed.success
    ? []
    : [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "result")))];
  if (!GMAIL_ID.test(input.gmailMessageId)) fields.unshift("gmailMessageId");
  if (!parsed.success || fields.length > 0) {
    return { ok: false, error: { kind: "InvalidClassification", fields } };
  }
  const r = parsed.data;
  return inSpan("db.mail_classification.record", { "northstar.mail.outcome": r.outcome }, (span) =>
    db.transaction(async (tx) => {
      const [link] = await tx
        .select({ id: mailLink.id })
        .from(mailLink)
        .where(
          and(
            eq(mailLink.candidateId, input.candidateId),
            eq(mailLink.gmailMessageId, input.gmailMessageId),
          ),
        );
      if (!link) return { ok: false as const, error: { kind: "UnknownMessage" as const } };
      const stored = storedRow(r);
      const [row] = await tx
        .insert(mailClassification)
        .values({
          candidateId: input.candidateId,
          gmailMessageId: input.gmailMessageId,
          outcome: r.outcome,
          ...stored,
        })
        .onConflictDoNothing({
          target: [mailClassification.candidateId, mailClassification.gmailMessageId],
        })
        .returning({ id: mailClassification.id, at: mailClassification.classifiedAt });
      // Already classified: the first decision stands.
      if (!row) return { ok: true as const, value: { recorded: false } };
      await appendEvent(tx, span, {
        candidateId: input.candidateId,
        aggregate: `mail_classification:${row.id}`,
        actor: "system",
        ...eventOf(r, input.gmailMessageId),
        idempotencyKey: `mail_classification:${input.candidateId}:${input.gmailMessageId}`,
        at: row.at,
      });
      return { ok: true as const, value: { recorded: true } };
    }),
  );
}

// The row's columns per outcome; the table's shape CHECK holds the same rules.
function storedRow(r: ClassificationResult) {
  switch (r.outcome) {
    case "classified":
      return {
        kind: r.kind,
        stageSignal: r.stageSignal,
        decidedBy: r.decidedBy,
        reviewReason: null,
        promptVersion: r.promptVersion ?? null,
      };
    case "review":
      return {
        kind: null,
        stageSignal: null,
        decidedBy: "model",
        reviewReason: r.reason,
        promptVersion: r.promptVersion,
      };
    case "skipped":
      return {
        kind: null,
        stageSignal: null,
        decidedBy: "rules",
        reviewReason: null,
        promptVersion: null,
      };
  }
}

// The feed event per outcome. The feed shows its reason (no template): fixed words only. The
// payload holds codes and the message id only.
function eventOf(r: ClassificationResult, gmailMessageId: string) {
  switch (r.outcome) {
    case "classified":
      return {
        type: "mail.classified",
        reason: `Sorted a job email: ${KIND_WORDS[r.kind]}`,
        payload: {
          gmailMessageId,
          kind: r.kind,
          stageSignal: r.stageSignal,
          decidedBy: r.decidedBy,
        },
      };
    case "review":
      return {
        type: "mail.needs_review",
        reason: "A job email needs your review: it couldn't be sorted with confidence",
        payload: { gmailMessageId, reason: r.reason },
      };
    case "skipped":
      return {
        type: "mail.verification_left_alone",
        reason: "Left a verification email alone",
        payload: { gmailMessageId },
      };
  }
}

export type StoredClassification = {
  gmailMessageId: string;
  outcome: "classified" | "review" | "skipped";
  kind: (typeof MAIL_KINDS)[number] | null;
  stageSignal: (typeof STAGE_SIGNALS)[number] | null;
  decidedBy: "rules" | "model";
  reviewReason: (typeof CLASSIFICATION_REVIEW_REASONS)[number] | null;
};

// The stored classifications among the given messages, the candidate's own only.
export async function readMailClassifications(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
  gmailMessageIds: readonly string[],
): Promise<StoredClassification[]> {
  if (gmailMessageIds.length === 0) return [];
  const rows = await db
    .select({
      gmailMessageId: mailClassification.gmailMessageId,
      outcome: mailClassification.outcome,
      kind: mailClassification.kind,
      stageSignal: mailClassification.stageSignal,
      decidedBy: mailClassification.decidedBy,
      reviewReason: mailClassification.reviewReason,
    })
    .from(mailClassification)
    .where(
      and(
        eq(mailClassification.candidateId, candidateId),
        inArray(mailClassification.gmailMessageId, [...gmailMessageIds]),
      ),
    );
  // The table's CHECKs allow only these values.
  return rows.map((r) => ({
    gmailMessageId: r.gmailMessageId,
    outcome: r.outcome as StoredClassification["outcome"],
    kind: r.kind as StoredClassification["kind"],
    stageSignal: r.stageSignal as StoredClassification["stageSignal"],
    decidedBy: r.decidedBy as StoredClassification["decidedBy"],
    reviewReason: r.reviewReason as StoredClassification["reviewReason"],
  }));
}
