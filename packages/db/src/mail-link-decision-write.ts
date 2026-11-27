import { APPLICATION_STATUSES, type CandidateId, isTerminal, type Result } from "@northstar/domain";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { mailLinkDecision } from "./mail-link-decision-schema.js";
import { mailLink } from "./mail-link-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import { application, company, job } from "./schema.js";

// Paul's choice for a thread in the confirm queue (NS-262, INB-006/009): link it to one of his open
// applications, or dismiss it. The queue shows threads, so a decision covers every queued message in
// the thread that has none yet. Recorded once per message by `user`; a link never moves a status
// (P1) and is never sender-verified (INB-011): queued mail had no authenticated match.

const GMAIL_ID = /^[0-9a-f]{1,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The statuses mail may still arrive for, as readLinkCandidates reads them.
const OPEN_STATUSES = APPLICATION_STATUSES.filter((s) => !isTerminal(s));

export type QueueDecision = { kind: "link"; applicationId: string } | { kind: "dismiss" };

export type QueueDecisionError =
  | { kind: "InvalidInput"; fields: string[] }
  // No queued message in this thread: nothing waits for Paul there.
  | { kind: "NotFound" }
  | { kind: "UnknownApplication" }
  | { kind: "ApplicationClosed" };

export async function decideQueuedThread(
  db: Db,
  input: { candidateId: CandidateId; gmailThreadId: string; decision: QueueDecision },
): Promise<Result<{ recorded: number }, QueueDecisionError>> {
  const fields: string[] = [];
  if (!GMAIL_ID.test(input.gmailThreadId)) fields.push("gmailThreadId");
  const decision = input.decision;
  if (decision.kind === "link" && !UUID.test(decision.applicationId)) fields.push("applicationId");
  if (decision.kind !== "link" && decision.kind !== "dismiss") fields.push("decision");
  if (fields.length > 0) return { ok: false, error: { kind: "InvalidInput", fields } };
  const applicationId = decision.kind === "link" ? decision.applicationId : null;

  return inSpan("db.mail_link.decide", { "northstar.mail_link.decision": decision.kind }, (span) =>
    db.transaction(async (tx) => {
      // The candidate's row lock serializes decisions, so two clicks can't both decide a message.
      await tx.execute(sql`select id from candidate where id = ${input.candidateId} for update`);
      // The application's status is read without its own lock: a move to rejected or withdrawn
      // landing just after does no harm, since a link never moves a status and matching only
      // offers open applications.
      if (applicationId !== null) {
        const [app] = await tx
          .select({ status: application.status })
          .from(application)
          .where(
            and(eq(application.id, applicationId), eq(application.candidateId, input.candidateId)),
          );
        if (!app) return { ok: false as const, error: { kind: "UnknownApplication" as const } };
        if (!OPEN_STATUSES.includes(app.status as (typeof OPEN_STATUSES)[number])) {
          return { ok: false as const, error: { kind: "ApplicationClosed" as const } };
        }
      }
      // The thread's queued messages, and which of them Paul already decided.
      const queued = await tx
        .select({ gmailMessageId: mailLink.gmailMessageId, decided: mailLinkDecision.id })
        .from(mailLink)
        .leftJoin(
          mailLinkDecision,
          and(
            eq(mailLinkDecision.candidateId, mailLink.candidateId),
            eq(mailLinkDecision.gmailMessageId, mailLink.gmailMessageId),
          ),
        )
        .where(
          and(
            eq(mailLink.candidateId, input.candidateId),
            eq(mailLink.gmailThreadId, input.gmailThreadId),
            isNull(mailLink.applicationId),
          ),
        )
        .orderBy(asc(mailLink.receivedAt), asc(mailLink.gmailMessageId));
      if (queued.length === 0) return { ok: false as const, error: { kind: "NotFound" as const } };
      const open = queued.filter((q) => q.decided === null).map((q) => q.gmailMessageId);
      // Every message already decided: a repeat, or a second choice, stores nothing.
      if (open.length === 0) return { ok: true as const, value: { recorded: 0 } };
      const rows = await tx
        .insert(mailLinkDecision)
        .values(
          open.map((gmailMessageId) => ({
            candidateId: input.candidateId,
            gmailMessageId,
            gmailThreadId: input.gmailThreadId,
            decision: applicationId === null ? "dismissed" : "linked",
            applicationId,
          })),
        )
        .returning({ id: mailLinkDecision.id, decidedAt: mailLinkDecision.decidedAt });
      const first = rows[0];
      if (!first) throw new Error("no decision row written");
      await appendEvent(tx, span, {
        candidateId: input.candidateId,
        aggregate:
          applicationId === null
            ? `mail_link_decision:${first.id}`
            : `application:${applicationId}`,
        type: applicationId === null ? "mail.link_dismissed" : "mail.link_confirmed",
        actor: "user",
        // The feed shows this reason: fixed words only.
        reason:
          applicationId === null
            ? "You dismissed a job email from the queue"
            : "You linked a job email to this application",
        payload: {
          gmailThreadId: input.gmailThreadId,
          messages: rows.length,
          ...(applicationId === null ? {} : { applicationId }),
        },
        // Each message is decided once, so its first message id keys this decision.
        idempotencyKey: `mail_link_decision:${input.candidateId}:${open[0]}`,
        at: first.decidedAt,
      });
      span.setAttribute("northstar.mail_link.recorded", rows.length);
      return { ok: true as const, value: { recorded: rows.length } };
    }),
  );
}

export type LinkTarget = { applicationId: string; jobTitle: string | null; company: string | null };

// More than this is cut, newest kept: far above the applications open at once.
export const MAX_LINK_TARGETS = 200;

// The open applications Paul can link a queued thread to, newest first. Read-only.
export async function readLinkTargets(db: Db, candidateId: CandidateId): Promise<LinkTarget[]> {
  return db
    .select({ applicationId: application.id, jobTitle: job.title, company: company.name })
    .from(application)
    .innerJoin(job, and(eq(job.id, application.jobId), eq(job.candidateId, candidateId)))
    .leftJoin(company, and(eq(company.id, job.companyId), eq(company.candidateId, candidateId)))
    .where(
      and(eq(application.candidateId, candidateId), inArray(application.status, OPEN_STATUSES)),
    )
    .orderBy(desc(application.createdAt), desc(application.id))
    .limit(MAX_LINK_TARGETS);
}
