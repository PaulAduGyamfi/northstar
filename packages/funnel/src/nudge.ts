import {
  DEFAULT_NUDGE_DAYS,
  type NudgeCandidate,
  type NudgeDays,
  type NudgeDue,
  type NudgeStage,
  nudgesDue,
} from "@northstar/domain";
import type { MessageHeaders, ReplyHeaders } from "@northstar/inbox";
import { dependencyDown, errorName, type LetterRow, letterKey, letterState } from "./inbox.js";
import { paulAnswered } from "./reply.js";

// Follow-up nudges in `funnel inbox` (NS-281 slice 2, RPL-004, RPL-002). After the recruiter
// replies, each application `nudgesDue` picks (gone quiet in the applied or interview stage, the
// company's turn, no reply filed on its newest verified message) gets one nudge package from
// `nudgePackage`, built from that message's own headers, filed with the Approval Gate through
// `fileReplyDraft`. Nothing is sent or written to Gmail: Paul approves each nudge in his Queue, and
// `funnel drafts` puts an approved one in his Gmail drafts. Off unless he turns on
// FOLLOW_UP_NUDGES. Codes and counts only leave this file.

// Nudges a run files at most, and applications it looks at at most (some are skipped as answered).
export const MAX_NUDGE = 10;
export const MAX_NUDGE_EXAMINE = 30;

export type NudgeLetterReason =
  | "read_failed"
  | "invalid_headers"
  | "no_reply_address"
  | "file_refused";

// What `nudgePackage` answers, by kind only: the package goes on to the filing port.
export type BuiltNudge =
  | { ok: true; value: unknown }
  | { ok: false; error: { kind: "InvalidReply" | "NoReplyAddress" } };

export type NudgeDeps = {
  enabled: boolean;
  now: () => Date;
  // The days of silence per stage (DEFAULT_NUDGE_DAYS unless the caller passes others).
  days?: NudgeDays;
  // Every `mail.nudge` letter with Paul's resolution (readDeadLetterKeys).
  nudgeLetters: () => Promise<readonly LetterRow[]>;
  // readNudgeCandidates: applications in a nudge stage with their newest verified linked message.
  candidates: () => Promise<readonly NudgeCandidate[]>;
  // Headers only, for "has Paul already followed up": the thread's ids and each one's labels.
  threadMessageIds: (threadId: string) => Promise<readonly { id: string }[]>;
  getHeaders: (gmailMessageId: string) => Promise<MessageHeaders>;
  getReplyHeaders: (gmailMessageId: string) => Promise<ReplyHeaders>;
  // nudgePackage over the message's own headers and the stage.
  build: (input: {
    gmailMessageId: string;
    threadId: string;
    inbound: ReplyHeaders;
    stage: NudgeStage;
  }) => BuiltNudge;
  // fileReplyDraft: the Gate request and the stored draft in one transaction.
  file: (nudge: unknown) => Promise<{ ok: boolean }>;
  recordNudgeLetter: (due: NudgeDue, reason: NudgeLetterReason, key: string) => Promise<void>;
};

export type NudgeReport = {
  enabled: boolean;
  filed: number;
  // Applications Paul already followed up on from Gmail: nothing is filed for them.
  answered: number;
  nudgeLetters: number;
  nudgeStoppedBy: string | null;
  moreToNudge: boolean;
};

export async function runNudges(deps: NudgeDeps): Promise<NudgeReport> {
  const r: NudgeReport = {
    enabled: deps.enabled,
    filed: 0,
    answered: 0,
    nudgeLetters: 0,
    nudgeStoppedBy: null,
    moreToNudge: false,
  };
  // Off: nothing is read, built or filed.
  if (!deps.enabled) return r;
  const letters = letterState(await deps.nudgeLetters(), "mail.nudge");
  // Plain code decides who is due: the clock, the stage and what is already filed.
  const due = nudgesDue(
    await deps.candidates(),
    deps.days ?? DEFAULT_NUDGE_DAYS,
    deps.now(),
  ).filter((d) => !letters.passOver.has(d.gmailMessageId));
  const giveUp = async (d: NudgeDue, reason: NudgeLetterReason) => {
    await deps.recordNudgeLetter(
      d,
      reason,
      letterKey("mail.nudge", d.gmailMessageId, letters.count),
    );
    r.nudgeLetters++;
  };
  let examined = 0;
  for (const d of due.slice(0, MAX_NUDGE_EXAMINE)) {
    if (r.filed >= MAX_NUDGE) break;
    examined++;
    let inbound: ReplyHeaders;
    try {
      if (await paulAnswered(deps, d)) {
        r.answered++;
        continue;
      }
      inbound = await deps.getReplyHeaders(d.gmailMessageId);
    } catch (e) {
      if (dependencyDown(e)) {
        r.nudgeStoppedBy = errorName(e);
        examined--;
        break;
      }
      await giveUp(d, "read_failed");
      continue;
    }
    const built = deps.build({
      gmailMessageId: d.gmailMessageId,
      threadId: d.threadId,
      inbound,
      stage: d.stage,
    });
    if (!built.ok) {
      await giveUp(
        d,
        built.error.kind === "NoReplyAddress" ? "no_reply_address" : "invalid_headers",
      );
      continue;
    }
    let saved: { ok: boolean };
    try {
      saved = await deps.file(built.value);
    } catch (e) {
      // A failure of the dependency stops the step; anything else is this nudge's letter, so one
      // bad filing never ends the run before its counts are printed.
      if (dependencyDown(e)) {
        r.nudgeStoppedBy = errorName(e);
        break;
      }
      saved = { ok: false };
    }
    if (!saved.ok) {
      await giveUp(d, "file_refused");
      continue;
    }
    r.filed++;
  }
  r.moreToNudge = due.length > examined;
  return r;
}
