import type { DraftClaim, readReplyDraft, VerifyError, verifyApproval } from "@northstar/db";
import {
  type CandidateId,
  err,
  ok,
  parseReplyPackage,
  type Result,
  replyContentSha256,
  replySubject,
} from "@northstar/domain";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { GmailComposeAccess } from "./access.js";
import { createDraftsClient } from "./drafts.js";
import { type DraftGuard, DraftHeldBack } from "./errors.js";
import { buildDraftMessage } from "./message.js";

// The Mail Gateway's draft writer (NS-237 slice 4, ADR-0025): an approved reply becomes a Gmail
// draft in its thread, once per approval, and is never sent. Paul sends it from Gmail himself.

// The claim on one approval (ADR-0025 item 5): `new` for the first caller, `done` with the draft's
// message id once recorded, `in_progress` while an earlier claim is young enough to still be
// running (the ledger decides the cutoff, as apply-write's live claim does), and `unknown` once an
// earlier claim is past that cutoff with no outcome recorded.
// The type lives with the stored ledger (`packages/db`, `reply-ledger-write.ts`) so the two can't drift.
export type { DraftClaim };

export type MailPorts = {
  readReplyDraft: (
    candidateId: CandidateId,
    requestId: string,
  ) => ReturnType<typeof readReplyDraft>;
  verifyApproval: (
    input: Parameters<typeof verifyApproval>[1],
  ) => ReturnType<typeof verifyApproval>;
  // The ledger: claim before the Gmail call, record its draft after (the database adapter and its
  // `reply.draft_created` event come with the ledger's migration).
  claimDraft: (candidateId: CandidateId, decisionId: string) => Promise<DraftClaim>;
  recordDraft: (
    candidateId: CandidateId,
    decisionId: string,
    draftMessageId: string,
  ) => Promise<void>;
  // The kill switch and breaker, scoped to the candidate.
  guard: (candidateId: CandidateId) => DraftGuard;
  // No fetch port (security review of NS-237 slice 5): the Authorization header carries the compose
  // token, so a caller-supplied fetch could keep it and call Gmail's send around the writer. The
  // drafts client uses the global fetch.
};

export type WriteDraftInput = {
  candidateId: CandidateId;
  // The Gate's decision id the caller was handed; looked up, never trusted.
  decisionId: string;
  // The `email_reply` request whose stored draft is written.
  requestId: string;
};

export type DraftWritten =
  | { kind: "created"; draftMessageId: string }
  | { kind: "already_created"; draftMessageId: string }
  // ADR-0025 item 6: the grant lacks gmail.compose. The draft stays in the approval view.
  | { kind: "needs_human"; reason: "scope_missing" };

export type DraftRefusal =
  | { kind: "NotFound" }
  | { kind: "ContentMismatch" }
  // Another run holds this approval's claim: come back at retryAt, never create beside it.
  | { kind: "InProgress"; retryAt: Date }
  // retryAt only for UndoWindowOpen: the window's end, when the caller comes back (never a drop).
  | { kind: "NotApproved"; reason: VerifyError["kind"] | "RequestMismatch"; retryAt?: Date }
  | {
      kind: "HeldBack";
      by: DraftHeldBack["by"];
      what: string;
      retryAt: Date | null;
    };

export async function writeReplyDraft(
  ports: MailPorts,
  access: GmailComposeAccess,
  input: WriteDraftInput,
): Promise<Result<DraftWritten, DraftRefusal>> {
  const tracer = trace.getTracer("@northstar/gateways");
  return tracer.startActiveSpan("gmail.write_reply_draft", async (span) => {
    const done = <T>(result: T, outcome: string): T => {
      span.setAttribute("northstar.mail.outcome", outcome);
      return result;
    };
    try {
      const { candidateId, decisionId } = input;
      // 1–2. The stored draft, checked and re-hashed: what goes to Gmail is what Paul approved.
      const stored = await ports.readReplyDraft(candidateId, input.requestId);
      if (!stored) return done(err({ kind: "NotFound" as const }), "not_found");
      const parsed = parseReplyPackage({
        gmailMessageId: stored.gmailMessageId,
        threadId: stored.threadId,
        envelope: stored.envelope,
        replyToOtherDomain: stored.replyToOtherDomain,
        body: stored.body,
        cites: stored.cites,
        followUps: stored.followUps,
      });
      if (!parsed.ok) return done(err({ kind: "ContentMismatch" as const }), "content_mismatch");
      const pkg = parsed.value;
      const contentSha256 = replyContentSha256(pkg);
      if (contentSha256 !== stored.contentSha256) {
        return done(err({ kind: "ContentMismatch" as const }), "content_mismatch");
      }
      // 3. The Gate, at the moment it acts (ADR-0002 item 3).
      const verified = await ports.verifyApproval({
        candidateId,
        decisionId,
        kind: "email_reply",
        subject: replySubject(pkg.gmailMessageId),
        contentSha256,
      });
      if (!verified.ok) {
        span.setAttribute("northstar.mail.refused", verified.error.kind);
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
      // The ledger and the marker are keyed by the decision, the content by the request: they
      // must be the same approval.
      if (verified.value.requestId !== input.requestId) {
        span.setAttribute("northstar.mail.refused", "RequestMismatch");
        return done(
          err({ kind: "NotApproved" as const, reason: "RequestMismatch" as const }),
          "not_approved",
        );
      }
      // 4. No compose scope: nothing goes to Gmail, and Paul is told why (ADR-0025 item 6).
      if (!access.hasComposeScope()) {
        return done(
          ok({ kind: "needs_human" as const, reason: "scope_missing" as const }),
          "scope_missing",
        );
      }
      // Built before the claim, so a refusal here can't leave a claim that never resolves.
      const raw = buildDraftMessage({ envelope: pkg.envelope, body: pkg.body, decisionId });
      // 5. One approval, one draft (RES-006).
      const claim = await ports.claimDraft(candidateId, decisionId);
      if (claim.state === "done") {
        return done(
          ok({ kind: "already_created" as const, draftMessageId: claim.draftMessageId }),
          "already_created",
        );
      }
      if (claim.state === "in_progress") {
        return done(err({ kind: "InProgress" as const, retryAt: claim.retryAt }), "in_progress");
      }
      const client = createDraftsClient({
        access,
        guard: ports.guard(candidateId),
      });
      if (claim.state === "unknown") {
        // An earlier run may have created it before it failed: look before creating another.
        const found = await client.findMarkedDraft(pkg.threadId, decisionId, span);
        if (found) {
          await ports.recordDraft(candidateId, decisionId, found);
          return done(ok({ kind: "already_created" as const, draftMessageId: found }), "found");
        }
      }
      // 6. The one Gmail write, then the ledger.
      const draftMessageId = await client.createDraft(raw, pkg.threadId, span);
      await ports.recordDraft(candidateId, decisionId, draftMessageId);
      return done(ok({ kind: "created" as const, draftMessageId }), "created");
    } catch (error) {
      if (error instanceof DraftHeldBack) {
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
      // The error's name only: never a message that could hold an id or text.
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
