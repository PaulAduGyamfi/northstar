import type { ClassificationResult, UnclassifiedMail } from "@northstar/db";
import {
  type FullMessage,
  GmailError,
  type MailPollReport,
  OAuthError,
  type TriageResult,
} from "@northstar/inbox";
import { describeHeldBack, HeldBack, LlmTransportError } from "@northstar/llm";
import { FunnelConfigError } from "./config.js";
import type { GradingReport } from "./grade.js";
import type { ReplyReport } from "./reply.js";

// `funnel inbox` (NS-238 item 1; INB-002/003/009/012): the mail loop, run once when Paul asks
// (#400: no stored Google token, no schedule). It links new mail from the stored cursor, then
// classifies what is recorded and unclassified. The Gmail token lives only inside the run
// (ADR-0014). Output is counts only: never a subject, sender, address, company or id.

// Polls a run makes at most: a stop is retried, and a message that stops all of them is given up on.
export const MAX_POLLS = 3;
// Classifications a run makes at most, so one run's model spend stays small.
export const MAX_CLASSIFY = 25;

export type LetterRow = { idempotencyKey: string; action: "retry" | "skip" | "hand_off" | null };
// `calendar.prep_write` (NS-241 slice 5, `funnel prep`) keys its letters by the approval's
// decision id the same way: `<kind>:<id>:<n>`.
export type LetterKind =
  | "mail.poll"
  | "mail.classify"
  | "mail.grade"
  | "mail.reply"
  | "calendar.prep_write"
  // NS-281 slice 1 (`funnel drafts`), keyed by the approval's decision id like prep writes.
  | "mail.draft_write";

// What the stored letters say about each message: pass it over unless Paul sent its newest letter
// back with Retry (an open letter, Skip and Hand off all keep it out), and how many letters it has,
// so a message that fails again after a Retry gets a new letter, not the old key again.
export function letterState(
  rows: readonly LetterRow[],
  kind: LetterKind,
): { passOver: Set<string>; retried: Set<string>; count: Map<string, number> } {
  const newest = new Map<string, LetterRow["action"]>();
  const count = new Map<string, number>();
  const prefix = `${kind}:`;
  // Oldest first, as readDeadLetterKeys gives them: the last one per message is its newest.
  for (const row of rows) {
    if (!row.idempotencyKey.startsWith(prefix)) continue;
    const gmailId = row.idempotencyKey.slice(prefix.length).split(":")[0];
    if (!gmailId) continue;
    newest.set(gmailId, row.action);
    count.set(gmailId, (count.get(gmailId) ?? 0) + 1);
  }
  const passOver = new Set([...newest].filter(([, a]) => a !== "retry").map(([id]) => id));
  // Sent back with Retry: the poll won't list these again once it has read past them, so the run
  // reads each one again by its id.
  const retried = new Set([...newest].filter(([, a]) => a === "retry").map(([id]) => id));
  return { passOver, retried, count };
}

// A message's next letter key: `<kind>:<gmail id>:<n>`, one more than it has.
export const letterKey = (kind: LetterKind, gmailId: string, count: Map<string, number>) =>
  `${kind}:${gmailId}:${(count.get(gmailId) ?? 0) + 1}`;

export type ClassifyLetterReason = "read_failed" | "classify_failed" | "record_refused";

export type InboxRunDeps = {
  // pollFromCursor with the link step bound; `skip` are the ids given up on.
  poll: (skip: ReadonlySet<string>) => Promise<MailPollReport>;
  // Every `mail.poll` and `mail.classify` letter with Paul's resolution (readDeadLetterKeys).
  pollLetters: () => Promise<readonly LetterRow[]>;
  classifyLetters: () => Promise<readonly LetterRow[]>;
  // Reads one message again by its id and runs the link step on it (pre-filter included); the step
  // records each message once, so a message already linked records nothing.
  relink: (gmailMessageId: string) => Promise<void>;
  // Which of these messages already have a mail_link row (readRecordedMessageIds).
  recorded: (gmailMessageIds: readonly string[]) => Promise<ReadonlySet<string>>;
  // `key` is the letter's idempotency key, built here (`letterKey`).
  recordPollLetter: (key: string, attempts: number) => Promise<void>;
  recordClassifyLetter: (
    mail: UnclassifiedMail,
    reason: ClassifyLetterReason,
    key: string,
  ) => Promise<void>;
  unclassified: (limit: number) => Promise<readonly UnclassifiedMail[]>;
  readFull: (gmailMessageId: string) => Promise<FullMessage>;
  classify: (mail: FullMessage) => Promise<TriageResult>;
  recordClassification: (
    gmailMessageId: string,
    result: ClassificationResult,
  ) => Promise<{ ok: boolean }>;
  // That a verification email was left alone (NS-271): a final outcome, so later runs don't read
  // it again. Its own port, since nothing about the mail is classified or kept (VER-005).
  recordSkipped: (gmailMessageId: string) => Promise<{ ok: boolean }>;
  ungradedRecruiterMail: () => Promise<number>;
  // The grading step (`runGrading`, grade.ts), after sorting; off unless RECRUITER_EXTRACT is on.
  grading: () => Promise<GradingReport>;
  // Reply drafts by grade (`runReplies`, reply.ts), after grading; off unless RECRUITER_REPLIES is on.
  replies: () => Promise<ReplyReport>;
};

export type InboxRunReport = {
  polls: number;
  listed: number;
  linked: number;
  queued: number;
  skipped: number;
  notJobMail: number;
  passedOver: number;
  truncated: boolean;
  // The error's name when the poll couldn't finish (a stop it didn't give up on, or a failed
  // listing); null when it finished.
  pollStoppedBy: string | null;
  pollLetters: number;
  // Messages Paul sent back with Retry that were read again this run.
  relinked: number;
  byRules: number;
  byModel: number;
  review: number;
  verification: number;
  classifyLetters: number;
  // Why classification stopped early (a held-back call, the API or Gmail not answering); null when
  // it got through its batch.
  classifyStoppedBy: string | null;
  // Unclassified messages are left for a later run.
  moreWaiting: boolean;
  recruiterWaiting: number;
  // Grading (slice 2): whether it ran, how many were graded or given up on, and why it stopped.
  gradingOn: boolean;
  graded: number;
  gradeLetters: number;
  gradeStoppedBy: string | null;
  // Reply drafts (NS-238 item 2's caller): whether it ran, what it filed, skipped or gave up on.
  repliesOn: boolean;
  repliesFiled: number;
  repliesAnswered: number;
  archiveSuggested: number;
  replyLetters: number;
  replyStoppedBy: string | null;
  moreToReply: boolean;
};

// A failure of the dependency, not of the message: stop, and leave the rest for a later run.
export function dependencyDown(e: unknown): boolean {
  if (e instanceof HeldBack || e instanceof LlmTransportError) return true;
  // 400 and 404 are about this message (bad id, deleted since); anything else is Gmail or the token.
  return e instanceof GmailError && e.status !== 400 && e.status !== 404;
}

// Stops the poll reports by an error's name that say Gmail, the token, a breaker or the cursor
// failed, not the message it stopped at: no letter for these. Gmail's own 400s and 404s are
// GmailErrors too; such a message stays at the head and the run says Gmail didn't answer.
const NOT_THE_MESSAGE = new Set(["HeldBack", "GmailError", "OAuthError", "FutureCursorError"]);

export const errorName = (e: unknown) => (e instanceof Error ? e.name : "Error");

export async function runInbox(deps: InboxRunDeps): Promise<InboxRunReport> {
  const r: InboxRunReport = {
    polls: 0,
    listed: 0,
    linked: 0,
    queued: 0,
    skipped: 0,
    notJobMail: 0,
    passedOver: 0,
    truncated: false,
    pollStoppedBy: null,
    pollLetters: 0,
    relinked: 0,
    byRules: 0,
    byModel: 0,
    review: 0,
    verification: 0,
    classifyLetters: 0,
    classifyStoppedBy: null,
    moreWaiting: false,
    recruiterWaiting: 0,
    gradingOn: false,
    graded: 0,
    gradeLetters: 0,
    gradeStoppedBy: null,
    repliesOn: false,
    repliesFiled: 0,
    repliesAnswered: 0,
    archiveSuggested: 0,
    replyLetters: 0,
    replyStoppedBy: null,
    moreToReply: false,
  };
  await linkNewMail(deps, r);
  await classifyRecorded(deps, r);
  const g = await deps.grading();
  r.gradingOn = g.enabled;
  r.graded = g.graded;
  r.gradeLetters = g.gradeLetters;
  r.gradeStoppedBy = g.gradeStoppedBy;
  r.recruiterWaiting = await deps.ungradedRecruiterMail();
  // After grading, so this run's new grades get their replies in the same run.
  const p = await deps.replies();
  r.repliesOn = p.enabled;
  r.repliesFiled = p.filed;
  r.repliesAnswered = p.answered;
  r.archiveSuggested = p.archiveSuggested;
  r.replyLetters = p.replyLetters;
  r.replyStoppedBy = p.replyStoppedBy;
  r.moreToReply = p.moreToReply;
  return r;
}

// Messages Paul sent back with Retry and not yet recorded: read each by its id and link it. A
// message that fails again gets a new letter and is passed over; Gmail, the token or a breaker
// failing stops the run's linking (false), leaving the rest for a later run.
async function relinkRetried(
  deps: InboxRunDeps,
  r: InboxRunReport,
  letters: ReturnType<typeof letterState>,
  skip: Set<string>,
): Promise<boolean> {
  if (letters.retried.size === 0) return true;
  const done = await deps.recorded([...letters.retried]);
  for (const gmailId of letters.retried) {
    if (done.has(gmailId)) continue;
    try {
      await deps.relink(gmailId);
      r.relinked++;
    } catch (e) {
      if (NOT_THE_MESSAGE.has(errorName(e))) {
        r.pollStoppedBy = errorName(e);
        return false;
      }
      await deps.recordPollLetter(letterKey("mail.poll", gmailId, letters.count), 1);
      skip.add(gmailId);
      r.pollLetters++;
    }
  }
  return true;
}

async function linkNewMail(deps: InboxRunDeps, r: InboxRunReport): Promise<void> {
  const letters = letterState(await deps.pollLetters(), "mail.poll");
  const skip = new Set(letters.passOver);
  if (!(await relinkRetried(deps, r, letters, skip))) return;
  // How many polls in this run stopped at each message.
  const stops = new Map<string, number>();
  // One more poll after each message given up on (at most MAX_POLLS more), so the mail after it is
  // still linked in this run.
  while (r.polls < MAX_POLLS + Math.min(r.pollLetters, MAX_POLLS)) {
    let p: MailPollReport;
    try {
      p = await deps.poll(skip);
    } catch (e) {
      // The listing or the cursor failed: nothing more to link this run; classification still runs.
      r.pollStoppedBy = errorName(e);
      return;
    }
    r.polls++;
    r.listed = Math.max(r.listed, p.listed);
    // A message handled by two polls counts twice; the step records it once.
    r.linked += p.linked;
    r.queued += p.queued;
    r.skipped += p.skipped;
    r.notJobMail += p.notJobMail;
    r.passedOver += p.passedOver;
    r.truncated = p.truncated;
    r.pollStoppedBy = p.stoppedBy;
    if (p.stoppedBy === null || p.stoppedAt === null) return;
    // Gmail, the token or a breaker failed, not the message: trying again now won't help, and the
    // message at the head of the list mustn't be blamed for an outage.
    if (NOT_THE_MESSAGE.has(p.stoppedBy)) return;
    const n = (stops.get(p.stoppedAt) ?? 0) + 1;
    stops.set(p.stoppedAt, n);
    if (n >= MAX_POLLS) {
      await deps.recordPollLetter(letterKey("mail.poll", p.stoppedAt, letters.count), n);
      skip.add(p.stoppedAt);
      r.pollLetters++;
      // Given up on and visible on /health: the poll isn't stuck any more.
      r.pollStoppedBy = null;
    }
  }
}

async function classifyRecorded(deps: InboxRunDeps, r: InboxRunReport): Promise<void> {
  const letters = letterState(await deps.classifyLetters(), "mail.classify");
  const lettered = letters.passOver;
  const giveUp = (m: UnclassifiedMail, reason: ClassifyLetterReason) =>
    deps.recordClassifyLetter(
      m,
      reason,
      letterKey("mail.classify", m.gmailMessageId, letters.count),
    );
  // Enough rows that lettered ones can't crowd out the batch; one more to know if any wait.
  const rows = (await deps.unclassified(MAX_CLASSIFY + lettered.size + 1)).filter(
    (m) => !lettered.has(m.gmailMessageId),
  );
  const batch = rows.slice(0, MAX_CLASSIFY);
  let done = 0;
  for (const m of batch) {
    let mail: FullMessage;
    try {
      mail = await deps.readFull(m.gmailMessageId);
    } catch (e) {
      if (dependencyDown(e)) {
        r.classifyStoppedBy = errorName(e);
        break;
      }
      await giveUp(m, "read_failed");
      r.classifyLetters++;
      done++;
      continue;
    }
    let t: TriageResult;
    try {
      t = await deps.classify(mail);
    } catch (e) {
      if (dependencyDown(e)) {
        r.classifyStoppedBy = errorName(e);
        break;
      }
      await giveUp(m, "classify_failed");
      r.classifyLetters++;
      done++;
      continue;
    }
    done++;
    const result = storedResult(t);
    // Verification mail belongs to the Verification Catcher: nothing is classified or sent
    // (INB-012). Only that it was left alone is stored, so later runs don't read it again; a
    // refused store is a letter like any other.
    if (result === null) {
      const left = await deps.recordSkipped(m.gmailMessageId);
      if (!left.ok) {
        await giveUp(m, "record_refused");
        r.classifyLetters++;
        continue;
      }
      r.verification++;
      continue;
    }
    const saved = await deps.recordClassification(m.gmailMessageId, result);
    if (!saved.ok) {
      await giveUp(m, "record_refused");
      r.classifyLetters++;
      continue;
    }
    if (t.kind === "review") r.review++;
    else if (t.kind === "classified" && t.by === "rules") r.byRules++;
    else r.byModel++;
  }
  r.moreWaiting = rows.length > done;
}

// What the store keeps from a triage result: codes only, never the company, role or requisition.
export function storedResult(t: TriageResult): ClassificationResult | null {
  switch (t.kind) {
    case "skip":
      return null;
    case "review":
      return { outcome: "review", reason: t.reason, promptVersion: t.stamp.promptVersion };
    case "classified":
      return t.by === "rules"
        ? {
            outcome: "classified",
            kind: t.classification.kind,
            stageSignal: t.classification.stageSignal,
            decidedBy: "rules",
          }
        : {
            outcome: "classified",
            kind: t.classification.kind,
            stageSignal: t.classification.stageSignal,
            decidedBy: "model",
            promptVersion: t.stamp.promptVersion,
          };
  }
}

export type InboxDeps = {
  print: (line: string) => void;
  runInbox: () => Promise<InboxRunReport>;
};

export async function inboxCommand(deps: InboxDeps): Promise<number> {
  let r: InboxRunReport;
  try {
    r = await deps.runInbox();
  } catch (error) {
    deps.print(`Inbox run stopped: ${describeError(error)}`);
    deps.print("What was saved stays; run it again to continue.");
    return 1;
  }
  deps.print(
    `New mail: ${r.listed} listed. Linked to an application: ${r.linked}. Waiting for you to link: ${r.queued}. Not job mail: ${r.notJobMail}. Skipped: ${r.skipped}.`,
  );
  if (r.truncated) deps.print("More mail is waiting than one run reads; run it again.");
  if (r.relinked > 0) deps.print(`Read again after your Retry: ${r.relinked}.`);
  if (r.passedOver + r.pollLetters > 0) {
    deps.print(
      `Passed over: ${r.passedOver + r.pollLetters} message(s) that kept failing. Each is in Stuck work on /health.`,
    );
  }
  deps.print(
    `Sorted: ${r.byRules + r.byModel} (${r.byRules} by rules, ${r.byModel} by the model). For your review: ${r.review}. Verification mail left alone: ${r.verification}.`,
  );
  if (r.classifyLetters > 0) {
    deps.print(`Couldn't sort: ${r.classifyLetters}. Each is in Stuck work on /health.`);
  }
  if (r.moreWaiting) deps.print("More mail is waiting to be sorted; run it again later.");
  if (r.gradingOn) {
    deps.print(`Graded recruiter emails: ${r.graded}.`);
    if (r.gradeLetters > 0) {
      deps.print(`Couldn't grade: ${r.gradeLetters}. Each is in Stuck work on /health.`);
    }
    if (r.recruiterWaiting > 0) {
      deps.print(`Recruiter emails still to grade: ${r.recruiterWaiting}; run it again later.`);
    }
  } else if (r.recruiterWaiting > 0) {
    deps.print(
      `Recruiter emails waiting for a grade: ${r.recruiterWaiting}. Grading starts once recruiter reading is turned on.`,
    );
  }
  let code = 0;
  if (r.pollStoppedBy !== null) {
    deps.print(`Reading new mail stopped early: ${stopWords(r.pollStoppedBy)}.`);
    code = 1;
  }
  if (r.classifyStoppedBy !== null) {
    deps.print(`Sorting stopped early: ${stopWords(r.classifyStoppedBy)}.`);
    code = 1;
  }
  if (r.gradeStoppedBy !== null) {
    deps.print(`Grading stopped early: ${stopWords(r.gradeStoppedBy)}.`);
    code = 1;
  }
  if (r.repliesOn) {
    deps.print(
      `Replies to recruiters sent to your Queue for approval: ${r.repliesFiled}. Already answered by you: ${r.repliesAnswered}.`,
    );
    if (r.archiveSuggested > 0) {
      deps.print(`No reply suggested (graded F, archive them): ${r.archiveSuggested}.`);
    }
    if (r.replyLetters > 0) {
      deps.print(`Couldn't prepare a reply: ${r.replyLetters}. Each is in Stuck work on /health.`);
    }
    if (r.moreToReply)
      deps.print("More recruiter emails are waiting for a reply; run it again later.");
  }
  if (r.replyStoppedBy !== null) {
    deps.print(`Preparing replies stopped early: ${stopWords(r.replyStoppedBy)}.`);
    code = 1;
  }
  if (r.queued > 0 || r.review > 0) deps.print("Link or review them on /inbox.");
  if (r.graded > 0) deps.print("See the grades on /inbox.");
  // Nothing is sent: each reply waits in the Queue until Paul approves it.
  if (r.repliesFiled > 0)
    deps.print("Read and approve the replies on /approvals. Nothing was sent.");
  return code;
}

// An error's name in words; never its message, which might quote a response.
function stopWords(name: string): string {
  if (name === "HeldBack") return "a switch, breaker or the spend cap is holding it back";
  if (name === "LlmTransportError") return "the Claude API didn't answer";
  if (name === "GmailError") return "Gmail didn't answer";
  if (name === "FutureCursorError") return "the stored mail cursor is in the future";
  if (name === "RecruiterExtractOff") return "recruiter reading is turned off";
  return name;
}

// Consent and Gmail errors carry fixed words and a status, never a token or mail text; anything
// else is named only.
function describeError(error: unknown): string {
  if (error instanceof OAuthError || error instanceof GmailError) return error.message;
  // Fixed words naming the setting, never its value.
  if (error instanceof FunnelConfigError) return error.message;
  if (error instanceof HeldBack) return `${describeHeldBack(error)}; run it again later`;
  return error instanceof Error ? error.name : "an unknown error";
}
