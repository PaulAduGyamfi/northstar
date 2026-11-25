import type { BatchOutcome, PendingApproval, ReasonRequired, UndoError } from "@northstar/db";
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
};

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
  z.object({ requestId: z.string(), outcome: z.enum(["not_found", "already_decided"]) }),
]);

// What each refusal of an undo means to the page.
const UNDO_ERRORS: Record<UndoError["kind"], { status: 404 | 409; error: string }> = {
  NotFound: { status: 404, error: "not_found" },
  AlreadyUndone: { status: 409, error: "already_undone" },
  UndoWindowClosed: { status: 409, error: "undo_window_closed" },
  SubjectReopened: { status: 409, error: "subject_reopened" },
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
      const r = await ports.decide({
        requestIds,
        decision,
        ...(reason === undefined ? {} : { reason }),
      });
      if (!r.ok) return { ok: false, status: 400, error: "reason_required" };
      return {
        ok: true,
        body: {
          outcomes: r.value.map((o) =>
            o.result.ok
              ? {
                  requestId: o.requestId,
                  outcome: o.result.value.decision,
                  decisionId: o.result.value.decisionId,
                  effectiveAt: o.result.value.effectiveAt.toISOString(),
                }
              : {
                  requestId: o.requestId,
                  outcome:
                    o.result.error.kind === "NotFound"
                      ? ("not_found" as const)
                      : ("already_decided" as const),
                },
          ),
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

  return [list, decide, undo];
}
