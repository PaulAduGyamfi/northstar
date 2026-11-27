import type {
  BatchOutcome,
  EditError,
  EditResult,
  PendingApproval,
  ReasonRequired,
  UndoError,
} from "@northstar/db";
import { APPROVAL_KINDS, type ApprovalKind, type Result } from "@northstar/domain";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// The approval queue (NS-139, APR-001…003, ADR-0002): what waits for Paul, and his decisions.
// Every endpoint needs his session, and these are the only callers of decideApprovals and
// undoDecision, so every decision the Gate records here is his (`decided_by = 'user'`). The body
// never names a decider: fields are picked by name, never spread. bin.ts wires the Gate
// (approval-ports.ts), tests fake it.

export type ApprovalPorts = {
  list: (kind: ApprovalKind | undefined) => Promise<PendingApproval[]>;
  decide: (input: {
    requestIds: string[];
    decision: "approve" | "reject";
    reason?: string;
  }) => Promise<Result<BatchOutcome[], ReasonRequired>>;
  undo: (decisionId: string) => Promise<Result<{ requestId: string }, UndoError>>;
  // A reply draft behind an email_reply request (NS-237 slice 2), which of a batch's requests are
  // replies with no draft, and which are replies to another domain than the sender's. Required, so
  // a wiring that leaves one out doesn't compile instead of quietly turning a guard off.
  readReply: (requestId: string) => Promise<ReplyView | null>;
  missingReplies: (requestIds: string[]) => Promise<string[]>;
  otherDomainReplies: (requestIds: string[]) => Promise<string[]>;
  // Paul's edit of a waiting reply's body (NS-203): the Gate withdraws the old request and files
  // one pinning the edited body.
  editReply: (input: { requestId: string; body: string }) => Promise<Result<EditResult, EditError>>;
};

// What Paul sees of a reply before he approves it: who it goes to (and whether that is another
// domain than the sender's), the subject and the body, never the thread headers.
export type ReplyView = {
  to: string;
  replyToOtherDomain: boolean;
  subject: string;
  body: string;
  cites: string[];
  followUps: string[];
};

const Reply = z.object({
  to: z.string(),
  replyToOtherDomain: z.boolean(),
  subject: z.string(),
  body: z.string(),
  cites: z.array(z.string()),
  followUps: z.array(z.string()),
});

// One call decides at most this many: "approve all" over a longer queue sends several calls.
export const MAX_BATCH = 100;

const Kind = z.enum(APPROVAL_KINDS);

const Queue = z.object({
  items: z.array(
    z.object({
      requestId: z.string(),
      kind: Kind,
      subject: z.string(),
      requestedAt: z.string(),
      // The request replaced one Paul edited (NS-203 slice 3).
      edited: z.boolean(),
    }),
  ),
});

const Decide = z.object({
  requestIds: z.array(z.uuid()).min(1).max(MAX_BATCH),
  decision: z.enum(["approve", "reject"]),
  // A reject reason is stored by the Gate (it feeds learning) and never put in an event or span.
  reason: z.string().max(500).optional(),
});

const Outcome = z.union([
  z.object({
    requestId: z.string(),
    outcome: z.enum(["approved", "rejected"]),
    decisionId: z.string(),
    effectiveAt: z.string(),
  }),
  z.object({
    requestId: z.string(),
    // missing_draft: an email reply with no stored draft is never approved (NS-237 slice 2).
    // approve_alone: a reply to another domain than the sender's is approved only on its own.
    outcome: z.enum(["not_found", "already_decided", "missing_draft", "approve_alone"]),
  }),
]);

// What each refusal of an undo means to the page.
const UNDO_ERRORS: Record<UndoError["kind"], { status: 404 | 409; error: string }> = {
  NotFound: { status: 404, error: "not_found" },
  AlreadyUndone: { status: 409, error: "already_undone" },
  UndoWindowClosed: { status: 409, error: "undo_window_closed" },
  SubjectReopened: { status: 409, error: "subject_reopened" },
  // The request was withdrawn (NS-140): closed, so its decision stays as it is.
  Withdrawn: { status: 409, error: "withdrawn" },
};

// What each refusal of an edit means to the page (NS-203). Never the body.
const EDIT_ERRORS: Record<EditError["kind"], { status: 400 | 404 | 409; error: string }> = {
  NotFound: { status: 404, error: "not_found" },
  NotPending: { status: 409, error: "not_pending" },
  NotEditable: { status: 409, error: "not_editable" },
  ContentUnchanged: { status: 409, error: "unchanged" },
  InvalidRequest: { status: 400, error: "invalid_body" },
};

export function approvalEndpoints(ports: ApprovalPorts): AnyEndpoint[] {
  const list = endpoint({
    method: "GET",
    path: "/approvals",
    auth: "session",
    input: z.object({ kind: Kind.optional() }),
    output: Queue,
    handler: async ({ kind }) => {
      let pending: PendingApproval[];
      try {
        pending = await ports.list(kind);
      } catch {
        // The queue can't be read (Postgres down): the page says so.
        return { ok: false, status: 503, error: "unavailable" };
      }
      return {
        ok: true,
        body: {
          items: pending.map((p) => ({
            requestId: p.requestId,
            kind: p.kind,
            subject: p.subject,
            requestedAt: p.requestedAt.toISOString(),
            edited: p.edited,
          })),
        },
      };
    },
  });

  const decide = endpoint({
    method: "POST",
    path: "/approvals/decide",
    auth: "session",
    input: Decide,
    output: z.object({ outcomes: z.array(Outcome) }),
    handler: async ({ requestIds, decision, reason }) => {
      // Approving a reply Paul can't see is refused before the Gate: it stays in the queue. A
      // reject still goes through, so an empty one can be cleared.
      const approving = decision === "approve";
      const missing = new Set(approving ? await ports.missingReplies(requestIds) : []);
      // A reply to another domain than the sender's is approved only on its own, so Paul has its
      // warning in front of him; a batch never carries one through (NS-237 slice 2).
      const alone = new Set(
        approving && requestIds.length > 1 ? await ports.otherDomainReplies(requestIds) : [],
      );
      const outcomeOf = (id: string) =>
        missing.has(id)
          ? ("missing_draft" as const)
          : alone.has(id)
            ? ("approve_alone" as const)
            : null;
      const toDecide = requestIds.filter((id) => outcomeOf(id) === null);
      // Refusals come first, then the Gate's outcomes: the page counts them, never relies on order.
      const refused = requestIds.flatMap((requestId) => {
        const outcome = outcomeOf(requestId);
        return outcome === null ? [] : [{ requestId, outcome }];
      });
      if (toDecide.length === 0) return { ok: true, body: { outcomes: refused } };
      const r = await ports.decide({
        requestIds: toDecide,
        decision,
        ...(reason === undefined ? {} : { reason }),
      });
      if (!r.ok) return { ok: false, status: 400, error: "reason_required" };
      return {
        ok: true,
        body: {
          outcomes: [
            ...refused,
            ...r.value.map((o) =>
              o.result.ok
                ? {
                    requestId: o.requestId,
                    outcome: o.result.value.decision,
                    decisionId: o.result.value.decisionId,
                    effectiveAt: o.result.value.effectiveAt.toISOString(),
                  }
                : {
                    requestId: o.requestId,
                    // A withdrawn request (NS-140) has left the queue: to the page it is gone.
                    outcome:
                      o.result.error.kind === "AlreadyDecided"
                        ? ("already_decided" as const)
                        : ("not_found" as const),
                  },
            ),
          ],
        },
      };
    },
  });

  const reply = endpoint({
    method: "GET",
    path: "/approvals/reply",
    auth: "session",
    input: z.object({ requestId: z.uuid() }),
    output: Reply,
    handler: async ({ requestId }) => {
      const found = await ports.readReply(requestId);
      if (found === null) return { ok: false, status: 404, error: "not_found" };
      // Field by field: nothing else from the stored row reaches the page.
      return {
        ok: true,
        body: {
          to: found.to,
          replyToOtherDomain: found.replyToOtherDomain,
          subject: found.subject,
          body: found.body,
          cites: found.cites,
          followUps: found.followUps,
        },
      };
    },
  });

  const undo = endpoint({
    method: "POST",
    path: "/approvals/undo",
    auth: "session",
    input: z.object({ decisionId: z.uuid() }),
    output: z.object({ requestId: z.string() }),
    handler: async ({ decisionId }) => {
      const r = await ports.undo(decisionId);
      if (!r.ok) {
        const e = UNDO_ERRORS[r.error.kind];
        return { ok: false, status: e.status, error: e.error };
      }
      return { ok: true, body: { requestId: r.value.requestId } };
    },
  });

  // Paul edits a waiting reply's body before approving it (NS-203, APR-002). The recipient,
  // subject and thread headers stay as filed; only the body is his to change here.
  const editReply = endpoint({
    method: "POST",
    path: "/approvals/edit-reply",
    auth: "session",
    // The Gate's own checks decide what a body may hold; this only bounds the request's size.
    input: z.object({ requestId: z.uuid(), body: z.string().min(1).max(10_000) }),
    output: z.object({ requestId: z.string() }),
    handler: async ({ requestId, body }) => {
      const r = await ports.editReply({ requestId, body });
      if (!r.ok) {
        const e = EDIT_ERRORS[r.error.kind];
        return { ok: false, status: e.status, error: e.error };
      }
      return { ok: true, body: { requestId: r.value.requestId } };
    },
  });

  return [list, decide, undo, reply, editReply];
}
