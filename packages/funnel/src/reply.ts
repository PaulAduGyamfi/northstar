import type { ReplyCandidate } from "@northstar/db";
import type { MessageHeaders, ReplyHeaders } from "@northstar/inbox";
import { dependencyDown, errorName, type LetterRow, letterKey, letterState } from "./inbox.js";

// Reply drafts by grade in `funnel inbox` (NS-238 item 2's caller, REC-002, RPL-002). After
// grading, each graded recruiter email with no draft yet gets one reply package from
// `recruiterReplyPackage`, built from the email's own headers, filed with the Approval Gate
// through `fileReplyDraft`. Nothing is sent or written to Gmail: Paul approves each reply in his
// Queue. Off unless he turns on RECRUITER_REPLIES. Codes and counts only leave this file.

// Replies a run files at most, and emails it looks at at most (some are skipped as answered).
export const MAX_REPLY = 10;
export const MAX_EXAMINE = 30;
// Only mail received in the last 14 days: turning the step on doesn't answer stale mail.
export const REPLY_WINDOW_DAYS = 14;

export type ReplyLetterReason =
  | "read_failed"
  | "invalid_headers"
  | "no_reply_address"
  | "file_refused";

const LETTERS = ["A", "B", "C", "D", "F"] as const;
export type ReplyLetter = (typeof LETTERS)[number];

// What `recruiterReplyPackage` answers, by kind only: the package goes on to the filing port.
export type BuiltReply =
  | { ok: true; value: unknown }
  | { ok: false; error: { kind: "InvalidReply" | "NoReplyAddress" | "ArchiveSuggested" } };

export type ReplyDeps = {
  enabled: boolean;
  now: () => Date;
  // Every `mail.reply` letter with Paul's resolution (readDeadLetterKeys).
  replyLetters: () => Promise<readonly LetterRow[]>;
  // readReplyCandidates: graded, no draft filed, not dismissed, not F, since the date.
  candidates: (since: Date, limit: number) => Promise<readonly ReplyCandidate[]>;
  // Headers only, for "has Paul already answered it": the thread's ids and each one's labels.
  threadMessageIds: (threadId: string) => Promise<readonly { id: string }[]>;
  getHeaders: (gmailMessageId: string) => Promise<MessageHeaders>;
  getReplyHeaders: (gmailMessageId: string) => Promise<ReplyHeaders>;
  // recruiterReplyPackage over the email's own headers and its letter.
  build: (input: {
    gmailMessageId: string;
    threadId: string;
    inbound: ReplyHeaders;
    grade: ReplyLetter;
  }) => BuiltReply;
  // fileReplyDraft: the Gate request and the stored draft in one transaction.
  file: (reply: unknown) => Promise<{ ok: boolean }>;
  recordReplyLetter: (
    mail: ReplyCandidate,
    reason: ReplyLetterReason,
    key: string,
  ) => Promise<void>;
};

export type ReplyReport = {
  enabled: boolean;
  filed: number;
  // Emails Paul had already answered from Gmail: nothing is filed for them.
  answered: number;
  // An F after all (a regrade landed meanwhile): no reply, only the suggestion to archive it.
  archiveSuggested: number;
  replyLetters: number;
  replyStoppedBy: string | null;
  moreToReply: boolean;
};

const isLetter = (grade: string): grade is ReplyLetter =>
  (LETTERS as readonly string[]).includes(grade);

// Whether a message Paul sent (Gmail's SENT label, set by Gmail, never by a sender) sits in the
// thread after this one. A draft he hasn't sent doesn't count.
async function paulAnswered(deps: ReplyDeps, mail: ReplyCandidate): Promise<boolean> {
  const own = await deps.getHeaders(mail.gmailMessageId);
  for (const { id } of await deps.threadMessageIds(mail.threadId)) {
    if (id === mail.gmailMessageId) continue;
    const other = await deps.getHeaders(id);
    if (other.labelIds?.includes("SENT") && other.receivedAt > own.receivedAt) return true;
  }
  return false;
}

export async function runReplies(deps: ReplyDeps): Promise<ReplyReport> {
  const r: ReplyReport = {
    enabled: deps.enabled,
    filed: 0,
    answered: 0,
    archiveSuggested: 0,
    replyLetters: 0,
    replyStoppedBy: null,
    moreToReply: false,
  };
  // Off: nothing is read, built or filed.
  if (!deps.enabled) return r;
  const letters = letterState(await deps.replyLetters(), "mail.reply");
  const since = new Date(deps.now().getTime() - REPLY_WINDOW_DAYS * 86_400_000);
  const rows = (await deps.candidates(since, MAX_EXAMINE + letters.passOver.size + 1)).filter(
    (m) => !letters.passOver.has(m.gmailMessageId),
  );
  const giveUp = async (m: ReplyCandidate, reason: ReplyLetterReason) => {
    await deps.recordReplyLetter(
      m,
      reason,
      letterKey("mail.reply", m.gmailMessageId, letters.count),
    );
    r.replyLetters++;
  };
  let examined = 0;
  for (const m of rows.slice(0, MAX_EXAMINE)) {
    if (r.filed >= MAX_REPLY) break;
    examined++;
    // The reader keeps letters A-F; anything else is a stored row this code doesn't know.
    if (!isLetter(m.grade)) {
      await giveUp(m, "invalid_headers");
      continue;
    }
    let inbound: ReplyHeaders;
    try {
      if (await paulAnswered(deps, m)) {
        r.answered++;
        continue;
      }
      inbound = await deps.getReplyHeaders(m.gmailMessageId);
    } catch (e) {
      if (dependencyDown(e)) {
        r.replyStoppedBy = errorName(e);
        examined--;
        break;
      }
      await giveUp(m, "read_failed");
      continue;
    }
    const built = deps.build({
      gmailMessageId: m.gmailMessageId,
      threadId: m.threadId,
      inbound,
      grade: m.grade,
    });
    if (!built.ok) {
      if (built.error.kind === "ArchiveSuggested") r.archiveSuggested++;
      else
        await giveUp(
          m,
          built.error.kind === "NoReplyAddress" ? "no_reply_address" : "invalid_headers",
        );
      continue;
    }
    const saved = await deps.file(built.value);
    if (!saved.ok) {
      await giveUp(m, "file_refused");
      continue;
    }
    r.filed++;
  }
  r.moreToReply = rows.length > examined;
  return r;
}
