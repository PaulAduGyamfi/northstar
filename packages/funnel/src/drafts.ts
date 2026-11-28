import type { ApprovedReply } from "@northstar/db";
import type { Result } from "@northstar/domain";
import type { DraftRefusal, DraftWritten } from "@northstar/gateways";
import { errorName, type LetterRow, letterKey, letterState } from "./inbox.js";

// `funnel drafts` (NS-281 slice 1, RPL-002, ADR-0025): the command Paul runs to put the replies he
// approved in the Queue into his Gmail drafts. It never sends: Paul sends each draft from Gmail
// himself. Google consent (gmail.compose only) is asked on this run, and only when there is an
// approved reply to write (#400: no stored token, no schedule). Plain code over ports.

// Why a reply went to Stuck work: a write that threw, or a refusal that no later run can clear.
export type DraftLetterReason =
  | "draft_failed"
  | "claims_exhausted"
  // The writer found no stored draft for the request, or it no longer hashes to what Paul approved.
  | "draft_not_found"
  | "draft_changed"
  // The Gate refused the decision for a reason that doesn't pass with time.
  | "approval_not_valid"
  // The ledger already holds a different draft for this decision.
  | "draft_conflict";

// What the run did. Counts only: printed to Paul's own terminal.
export type DraftsRunReport = {
  // Approved replies this run tried to write.
  approved: number;
  // Drafts created in Gmail this run.
  written: number;
  // Drafts an earlier, interrupted run had already created (found by their marker or recorded).
  alreadyThere: number;
  // Held back this run (switch, breaker, another run's claim, undo window); a later run tries again.
  skipped: number;
  // Passed over because they are in Stuck work, waiting for Paul.
  passedOver: number;
  // Sent to Stuck work this run.
  stuck: number;
  // The grant lacks gmail.compose: Paul allows it on the consent page, then reruns.
  scopeMissing: boolean;
  // Why writing stopped early (consent or Gmail not answering), by the error's name.
  stoppedBy: string | null;
  // The `gmail_drafts` kill switch is off: nothing was claimed and no consent was asked.
  switchedOff: boolean;
};

export type DraftWriter = (reply: ApprovedReply) => Promise<Result<DraftWritten, DraftRefusal>>;

export type DraftsRunDeps = {
  // readApprovedReplies.
  approved: () => Promise<readonly ApprovedReply[]>;
  // Every `mail.draft_write` letter with Paul's resolution (readDeadLetterKeys).
  letters: () => Promise<readonly LetterRow[]>;
  recordLetter: (reply: ApprovedReply, reason: DraftLetterReason, key: string) => Promise<void>;
  // Whether the stored `gmail_drafts` kill switch is on. Asked before consent: the writer claims
  // each decision before its own guard asks the switch, so a run while it is off would only leave
  // claims behind (each one a step towards `claims_exhausted`) and a consent page for nothing.
  switchOn: () => Promise<boolean>;
  // Asks gmail.compose consent for this run and returns writeReplyDraft bound to that token.
  consent: () => Promise<DraftWriter>;
};

export async function runDrafts(deps: DraftsRunDeps): Promise<DraftsRunReport> {
  const r: DraftsRunReport = {
    approved: 0,
    written: 0,
    alreadyThere: 0,
    skipped: 0,
    passedOver: 0,
    stuck: 0,
    scopeMissing: false,
    stoppedBy: null,
    switchedOff: false,
  };
  const letters = letterState(await deps.letters(), "mail.draft_write");
  const all = await deps.approved();
  const replies = all.filter((reply) => !letters.passOver.has(reply.decisionId));
  r.passedOver = all.length - replies.length;
  // Nothing approved: no consent page for nothing.
  if (replies.length === 0) return r;
  if (!(await deps.switchOn())) {
    r.switchedOff = true;
    return r;
  }
  let write: DraftWriter;
  try {
    write = await deps.consent();
  } catch (e) {
    r.stoppedBy = errorName(e);
    return r;
  }
  const giveUp = async (reply: ApprovedReply, reason: DraftLetterReason) => {
    await deps.recordLetter(
      reply,
      reason,
      letterKey("mail.draft_write", reply.decisionId, letters.count),
    );
    r.stuck++;
  };
  for (const reply of replies) {
    r.approved++;
    let answer: Result<DraftWritten, DraftRefusal>;
    try {
      answer = await write(reply);
    } catch (e) {
      // Gmail not answering is about Gmail, not this reply: stop, with no letter, and a later run
      // continues (the claim's lease lets it look for the draft first). The breaker counts these.
      if (gmailDown(e)) {
        r.stoppedBy = errorName(e);
        return r;
      }
      await giveUp(reply, thrownReason(e));
      continue;
    }
    if (!answer.ok) {
      const reason = lasting(answer.error);
      if (reason === null) r.skipped++;
      else await giveUp(reply, reason);
      continue;
    }
    switch (answer.value.kind) {
      case "needs_human":
        // The grant can't write drafts: every other reply would answer the same.
        r.scopeMissing = true;
        return r;
      case "already_created":
        r.alreadyThere++;
        break;
      case "created":
        r.written++;
        break;
    }
  }
  return r;
}

// A refusal no later run can clear goes to Stuck work; the others wait for a later run.
export function lasting(refusal: DraftRefusal): DraftLetterReason | null {
  switch (refusal.kind) {
    case "NotFound":
      return "draft_not_found";
    case "ContentMismatch":
      return "draft_changed";
    // The undo window passes; any other Gate refusal (or a decision for another request) stays.
    case "NotApproved":
      return refusal.reason === "UndoWindowOpen" ? null : "approval_not_valid";
    case "InProgress":
    case "HeldBack":
      return null;
  }
}

// The ledger's own refusals by name (packages/db, reply-ledger-write.ts); anything else that threw
// is a failed write.
function thrownReason(e: unknown): DraftLetterReason {
  switch (errorName(e)) {
    case "DraftClaimsExhausted":
      return "claims_exhausted";
    case "DraftRecordConflict":
      return "draft_conflict";
    default:
      return "draft_failed";
  }
}

// The drafts client's own failure (DraftWriteError) with no answer, a rate limit or a server error:
// Gmail is down or busy, so every reply would fail the same way.
function gmailDown(e: unknown): boolean {
  if (errorName(e) !== "DraftWriteError") return false;
  const status = (e as { status?: unknown }).status;
  return typeof status === "number" && (status === 0 || status === 429 || status >= 500);
}

export type DraftsDeps = {
  print: (line: string) => void;
  runDrafts: () => Promise<DraftsRunReport>;
};

export async function draftsCommand(deps: DraftsDeps): Promise<number> {
  let r: DraftsRunReport;
  try {
    r = await deps.runDrafts();
  } catch (error) {
    deps.print(`Writing Gmail drafts stopped: ${errorName(error)} (no details are printed).`);
    deps.print("Drafts already written stay; run it again to retry. Nothing was sent.");
    return 1;
  }
  let code = 0;
  if (r.stoppedBy !== null) {
    deps.print(
      `Approved replies put in your Gmail drafts: ${r.written}. The rest weren't: Google's consent didn't finish or Gmail didn't answer (${r.stoppedBy}). Run it again later; no draft is written twice.`,
    );
    code = 1;
  } else if (r.scopeMissing) {
    deps.print(
      "Approved replies weren't written: Google didn't grant Gmail drafts access. Allow it on the consent page and run it again.",
    );
    code = 1;
  } else if (r.switchedOff) {
    deps.print(
      "Approved replies weren't written: Gmail drafts are switched off on the Health page. Turn them on there and run it again.",
    );
    code = 1;
  } else if (r.approved === 0) {
    // Every approved reply may be waiting in Stuck work: the line below says so.
    if (r.passedOver === 0)
      deps.print("No approved replies are waiting to go in your Gmail drafts.");
  } else {
    deps.print(
      `Approved replies put in your Gmail drafts: ${r.written} of ${r.approved}${r.alreadyThere > 0 ? ` (${r.alreadyThere} already there from an earlier run)` : ""}. Held back for later: ${r.skipped}.`,
    );
  }
  // Said whatever stopped the writing, so a letter written earlier in the run is never unmentioned.
  if (r.stuck + r.passedOver > 0) {
    deps.print(
      `In Stuck work on /health: ${r.stuck} new, ${r.passedOver} waiting for you. Retry one there and the next run writes it.`,
    );
  }
  if (r.written + r.alreadyThere > 0) {
    deps.print("Nothing was sent: open Gmail's Drafts, read each one and send it yourself.");
  }
  return r.stuck > 0 ? 1 : code;
}
