import type { ClassificationResult, UnclassifiedMail } from "@northstar/db";
import {
  type FullMessage,
  GmailError,
  type MailPollReport,
  OAuthError,
  type TriageResult,
} from "@northstar/inbox";
import { describeHeldBack, HeldBack, LlmTransportError } from "@northstar/llm";

// `funnel inbox` (NS-238 item 1; INB-002/003/009/012): the mail loop, run once when Paul asks
// (#400: no stored Google token, no schedule). It links new mail from the stored cursor, then
// classifies what is recorded and unclassified. The Gmail token lives only inside the run
// (ADR-0014). Output is counts only: never a subject, sender, address, company or id.

// Polls a run makes at most: a stop is retried, and a message that stops all of them is given up on.
export const MAX_POLLS = 3;
// Classifications a run makes at most, so one run's model spend stays small.
export const MAX_CLASSIFY = 25;

export type LetterRow = { idempotencyKey: string; action: "retry" | "skip" | "hand_off" | null };
type LetterKind = "mail.poll" | "mail.classify";

// What the stored letters say about each message: pass it over unless Paul sent its newest letter
// back with Retry (an open letter, Skip and Hand off all keep it out), and how many letters it has,
// so a message that fails again after a Retry gets a new letter, not the old key again.
export function letterState(
  rows: readonly LetterRow[],
  kind: LetterKind,
): { passOver: Set<string>; count: Map<string, number> } {
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
  return { passOver, count };
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
  ungradedRecruiterMail: () => Promise<number>;
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
};

// A failure of the dependency, not of the message: stop, and leave the rest for a later run.
function dependencyDown(e: unknown): boolean {
  if (e instanceof HeldBack || e instanceof LlmTransportError) return true;
  // 400 and 404 are about this message (bad id, deleted since); anything else is Gmail or the token.
  return e instanceof GmailError && e.status !== 400 && e.status !== 404;
}

// Stops the poll reports by an error's name that say Gmail, the token, a breaker or the cursor
// failed, not the message it stopped at: no letter for these. Gmail's own 400s and 404s are
// GmailErrors too; such a message stays at the head and the run says Gmail didn't answer.
const NOT_THE_MESSAGE = new Set(["HeldBack", "GmailError", "OAuthError", "FutureCursorError"]);

const errorName = (e: unknown) => (e instanceof Error ? e.name : "Error");

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
    byRules: 0,
    byModel: 0,
    review: 0,
    verification: 0,
    classifyLetters: 0,
    classifyStoppedBy: null,
    moreWaiting: false,
    recruiterWaiting: 0,
  };
  await linkNewMail(deps, r);
  await classifyRecorded(deps, r);
  r.recruiterWaiting = await deps.ungradedRecruiterMail();
  return r;
}

async function linkNewMail(deps: InboxRunDeps, r: InboxRunReport): Promise<void> {
  const letters = letterState(await deps.pollLetters(), "mail.poll");
  const skip = new Set(letters.passOver);
  // How many polls in this run stopped at each message.
  const stops = new Map<string, number>();
  while (r.polls < MAX_POLLS) {
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
    // Verification mail belongs to the Verification Catcher: nothing is stored or sent (INB-012).
    if (result === null) {
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
  if (r.recruiterWaiting > 0) {
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
  if (r.queued > 0 || r.review > 0) deps.print("Link or review them on /inbox.");
  return code;
}

// An error's name in words; never its message, which might quote a response.
function stopWords(name: string): string {
  if (name === "HeldBack") return "a switch, breaker or the spend cap is holding it back";
  if (name === "LlmTransportError") return "the Claude API didn't answer";
  if (name === "GmailError") return "Gmail didn't answer";
  if (name === "FutureCursorError") return "the stored mail cursor is in the future";
  return name;
}

// Consent and Gmail errors carry fixed words and a status, never a token or mail text; anything
// else is named only.
function describeError(error: unknown): string {
  if (error instanceof OAuthError || error instanceof GmailError) return error.message;
  if (error instanceof HeldBack) return `${describeHeldBack(error)}; run it again later`;
  return error instanceof Error ? error.name : "an unknown error";
}
