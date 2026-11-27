import type {
  PrepClaim,
  readPrepPlan,
  StoredPrepPlan,
  VerifyError,
  verifyApproval,
  withdrawApproval,
} from "@northstar/db";
import {
  type CandidateId,
  err,
  ok,
  prepEventId,
  prepPlanContentSha256,
  prepPlanSubject,
  type Result,
} from "@northstar/domain";
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import type { CalendarWriteAccess } from "./access.js";
import { type CalendarWriteGuard, CalendarWriteHeldBack } from "./errors.js";
import { createCalendarWriteClient } from "./requests.js";

// The Calendar Gateway's writer (NS-241 slice 4, ADR-0031): an approved prep plan goes onto the
// Northstar calendar, each block once. It only inserts: Paul moves or removes a block himself.

const MAX_PREP_BLOCKS = 3;

// The type lives with the stored ledger (`packages/db`, `prep-ledger-write.ts`) so the two can't
// drift.
export type { PrepClaim };

export type CalendarPorts = {
  readPrepPlan: (candidateId: CandidateId, requestId: string) => ReturnType<typeof readPrepPlan>;
  verifyApproval: (
    input: Parameters<typeof verifyApproval>[1],
  ) => ReturnType<typeof verifyApproval>;
  // Only ever by `gateway`, with the hash of the plan as it now stands (ADR-0031 item 4).
  withdrawApproval: (input: {
    candidateId: CandidateId;
    requestId: string;
    by: "gateway";
    newContentSha256: string;
  }) => ReturnType<typeof withdrawApproval>;
  // The ledger: claim before the first Google call, record after the last.
  claimPrepWrite: (candidateId: CandidateId, decisionId: string) => Promise<PrepClaim>;
  recordPrepWrite: (
    candidateId: CandidateId,
    input: { decisionId: string; proposalId: string; blockCount: number },
  ) => Promise<void>;
  readNorthstarCalendar: (candidateId: CandidateId) => Promise<string | null>;
  saveNorthstarCalendar: (candidateId: CandidateId, calendarId: string) => Promise<void>;
  // The kill switch and breaker, scoped to the candidate.
  guard: (candidateId: CandidateId) => CalendarWriteGuard;
  // No fetch port: the requests carry the write token (as for the draft writer).
};

export type WritePrepInput = {
  candidateId: CandidateId;
  // The Gate's decision id the caller was handed; looked up, never trusted.
  decisionId: string;
  // The `prep_plan` request whose stored plan is written.
  requestId: string;
};

export type PrepWritten =
  | { kind: "written"; created: number; existing: number }
  | { kind: "already_written"; blockCount: number }
  // ADR-0031 item 8: the grant lacks calendar.app.created.
  | { kind: "needs_human"; reason: "scope_missing" };

export type PrepRefusal =
  | { kind: "NotFound" }
  | { kind: "ContentMismatch" }
  // A reschedule changed the interview: the approval is withdrawn (when the Gate allowed it) and
  // nothing is written; the next run proposes for the new time.
  | { kind: "Rescheduled"; withdrawn: boolean }
  // Another run holds the candidate's write claim: come back at retryAt.
  | { kind: "InProgress"; retryAt: Date }
  // retryAt only for UndoWindowOpen: the window's end, when the caller comes back.
  | { kind: "NotApproved"; reason: VerifyError["kind"] | "RequestMismatch"; retryAt?: Date }
  | { kind: "HeldBack"; by: CalendarWriteHeldBack["by"]; what: string; retryAt: Date | null };

export async function writePrepPlan(
  ports: CalendarPorts,
  access: CalendarWriteAccess,
  input: WritePrepInput,
): Promise<Result<PrepWritten, PrepRefusal>> {
  const tracer = trace.getTracer("@northstar/gateways");
  return tracer.startActiveSpan("calendar.write_prep_plan", async (span) => {
    const done = <T>(result: T, outcome: string): T => {
      span.setAttribute("northstar.calendar.outcome", outcome);
      return result;
    };
    try {
      const { candidateId, decisionId } = input;
      // 1. The stored plan, re-hashed over the detection it was filed for: what goes to Google is
      // what Paul approved.
      const plan = await ports.readPrepPlan(candidateId, input.requestId);
      if (!plan) return done(err({ kind: "NotFound" as const }), "not_found");
      const contentSha256 = hashOver(plan, plan.filedFor);
      // At most the planner's three blocks (two prep, one warm-up): the ledger's lease is sized for
      // that many inserts, and the record's CHECK allows no more.
      if (
        contentSha256 !== plan.contentSha256 ||
        plan.blocks.length === 0 ||
        plan.blocks.length > MAX_PREP_BLOCKS
      ) {
        return done(err({ kind: "ContentMismatch" as const }), "content_mismatch");
      }
      // 2. The Gate, at the moment it acts (ADR-0002 item 3).
      const verified = await ports.verifyApproval({
        candidateId,
        decisionId,
        kind: "prep_plan",
        subject: prepPlanSubject(plan.proposalId),
        contentSha256,
      });
      if (!verified.ok) {
        span.setAttribute("northstar.calendar.refused", verified.error.kind);
        const refusal =
          verified.error.kind === "UndoWindowOpen"
            ? {
                kind: "NotApproved" as const,
                reason: verified.error.kind,
                retryAt: verified.error.effectiveAt,
              }
            : { kind: "NotApproved" as const, reason: verified.error.kind };
        return done(err(refusal), "not_approved");
      }
      // The ledger and event ids are keyed by the decision, the plan by the request: they must
      // be the same approval.
      if (verified.value.requestId !== input.requestId) {
        span.setAttribute("northstar.calendar.refused", "RequestMismatch");
        return done(
          err({ kind: "NotApproved" as const, reason: "RequestMismatch" as const }),
          "not_approved",
        );
      }
      // 3. The interview as it is now (ADR-0031 item 4): a reschedule makes a new detection
      // version, so the plan's hash over the current one differs and the approval no longer fits.
      const current = plan.current;
      if (
        current === null ||
        current.detectionId !== plan.filedFor.detectionId ||
        !current.confirmed
      ) {
        const now = current ? hashOver(plan, current) : null;
        let withdrawn = false;
        if (now !== null && now !== contentSha256) {
          const closed = await ports.withdrawApproval({
            candidateId,
            requestId: input.requestId,
            by: "gateway",
            newContentSha256: now,
          });
          withdrawn = closed.ok;
          if (!closed.ok)
            span.setAttribute("northstar.calendar.withdraw_refused", closed.error.kind);
        }
        return done(err({ kind: "Rescheduled" as const, withdrawn }), "rescheduled");
      }
      // 4. No write scope: nothing goes to Google, and Paul is told why (ADR-0031 item 8).
      if (!access.hasWriteScope()) {
        return done(
          ok({ kind: "needs_human" as const, reason: "scope_missing" as const }),
          "scope_missing",
        );
      }
      // Built before the claim, so a refusal here can't leave a claim that never resolves.
      const events = plan.blocks.map((b, i) => ({
        id: prepEventId(decisionId, i),
        kind: b.kind,
        start: b.start,
        end: b.end,
      }));
      // 5. One approval, one write (RES-006).
      const claim = await ports.claimPrepWrite(candidateId, decisionId);
      if (claim.state === "done") {
        return done(
          ok({ kind: "already_written" as const, blockCount: claim.blockCount }),
          "already_written",
        );
      }
      if (claim.state === "in_progress") {
        return done(err({ kind: "InProgress" as const, retryAt: claim.retryAt }), "in_progress");
      }
      span.setAttribute("northstar.calendar.claim", claim.state);
      const client = createCalendarWriteClient({ access, guard: ports.guard(candidateId) });
      // 6. The candidate's calendar: stored, else the marked one an earlier run made before it
      // could store it, else a new one, stored as soon as Google names it.
      const calendarId = await northstarCalendarId(ports, client, candidateId, span);
      // 7. Each block once: its id comes from the decision, so a retry's insert answers 409.
      let created = 0;
      for (const event of events) {
        const answer = await client.insertPrepEvent(calendarId, event, span);
        if (answer === "created") created += 1;
      }
      // 8. The ledger, with the feed event.
      await ports.recordPrepWrite(candidateId, {
        decisionId,
        proposalId: plan.proposalId,
        blockCount: events.length,
      });
      span.setAttributes({
        "northstar.calendar.created": created,
        "northstar.calendar.existing": events.length - created,
      });
      return done(
        ok({ kind: "written" as const, created, existing: events.length - created }),
        "written",
      );
    } catch (error) {
      if (error instanceof CalendarWriteHeldBack) {
        return done(
          err({
            kind: "HeldBack" as const,
            by: error.by,
            what: error.what,
            retryAt: error.retryAt,
          }),
          "held_back",
        );
      }
      // The error's name only: never a message that could hold an id.
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.name : "Error",
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

// The plan's hash over one detection (the one it was filed for, or the current one).
function hashOver(plan: StoredPrepPlan, detection: { detectionId: string; version: number }) {
  return prepPlanContentSha256({
    proposalId: plan.proposalId,
    detectionId: detection.detectionId,
    detectionVersion: detection.version,
    blocks: plan.blocks,
  });
}

async function northstarCalendarId(
  ports: CalendarPorts,
  client: ReturnType<typeof createCalendarWriteClient>,
  candidateId: CandidateId,
  span: Span,
): Promise<string> {
  const stored = await ports.readNorthstarCalendar(candidateId);
  if (stored !== null) {
    span.setAttribute("northstar.calendar.calendar", "stored");
    return stored;
  }
  // Never matched by name alone: only the fixed marker (ADR-0031 item 5).
  const found = await client.findMarkedCalendar(span);
  const calendarId = found ?? (await client.createCalendar(span));
  span.setAttribute("northstar.calendar.calendar", found ? "found" : "created");
  await ports.saveNorthstarCalendar(candidateId, calendarId);
  return calendarId;
}
