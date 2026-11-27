import type { ApprovedPrepPlan, FiledPrepPlan, StoredInterview } from "@northstar/db";
import type { Result } from "@northstar/domain";
import type { PrepRefusal, PrepWritten } from "@northstar/gateways";
import type { PrepConfig } from "./config.js";
import { errorName, type LetterRow, letterKey, letterState } from "./inbox.js";

// `funnel prep` (NS-241 slice 5, CAL-003, ADR-0031): the command Paul runs to plan prep for his
// confirmed interviews, file each plan with the Approval Gate, and write the plans he approved
// onto his Northstar calendar. Google consent is asked on this run only, and only when there is
// something approved to write (#400: no stored token). Plain code over ports; output is counts.

export type PrepLetterReason = "write_failed" | "claims_exhausted";

// What the run did with each step's answers. Counts only: never a time, zone, title or id.
export type PrepRunReport = {
  proposed: number;
  // Interviews whose proposal was refused (started, replaced by a reschedule, no longer confirmed).
  notProposed: number;
  filed: number;
  // Filed on an earlier run (waiting, decided or closed): nothing new to file.
  waiting: number;
  // Not filed: the interview was rescheduled, unconfirmed, or the planner placed nothing.
  notFiled: number;
  // Approved plans this run tried to write.
  approved: number;
  written: number;
  // Approved plans held back this run (switch, breaker, another run's claim, undo window,
  // reschedule, or the approval no longer standing); a later run tries again.
  skipped: number;
  // Approved plans passed over because they are in Stuck work, waiting for Paul.
  passedOver: number;
  // Plans that failed to write and went to Stuck work this run.
  stuck: number;
  // The grant lacks calendar.app.created: Paul enables it, then reruns.
  scopeMissing: boolean;
  // Why writing stopped early (consent or Google not answering), by the error's name.
  writeStoppedBy: string | null;
};

export type PrepWriter = (plan: ApprovedPrepPlan) => Promise<Result<PrepWritten, PrepRefusal>>;

export type PrepRunDeps = {
  config: PrepConfig;
  now: () => Date;
  // The candidate's current interview detections with Paul's decisions (listInterviews).
  interviews: () => Promise<readonly StoredInterview[]>;
  // The stored proposal's id for a detection, or null (readPrepProposal).
  proposalOf: (detectionId: string) => Promise<string | null>;
  // proposeInterviewPrep, with no busy time in this slice.
  propose: (
    detectionId: string,
    request: {
      busy: [];
      workingHours: PrepConfig["workingHours"];
      timeZone: string;
      now: Date;
    },
  ) => Promise<Result<{ proposalId: string }, { kind: string }>>;
  // requestPrepPlanApproval.
  file: (proposalId: string) => Promise<Result<FiledPrepPlan, { kind: string }>>;
  // readApprovedPrepPlans.
  approved: () => Promise<readonly ApprovedPrepPlan[]>;
  // Every `calendar.prep_write` letter with Paul's resolution (readDeadLetterKeys).
  letters: () => Promise<readonly LetterRow[]>;
  recordLetter: (plan: ApprovedPrepPlan, reason: PrepLetterReason, key: string) => Promise<void>;
  // Asks Calendar write consent for this run and returns the writer bound to that token.
  consent: () => Promise<PrepWriter>;
};

export async function runPrep(deps: PrepRunDeps): Promise<PrepRunReport> {
  const r: PrepRunReport = {
    proposed: 0,
    notProposed: 0,
    filed: 0,
    waiting: 0,
    notFiled: 0,
    approved: 0,
    written: 0,
    skipped: 0,
    passedOver: 0,
    stuck: 0,
    scopeMissing: false,
    writeStoppedBy: null,
  };
  const now = deps.now();
  // Only interviews Paul confirmed that are still ahead: a started one gets no plan.
  const upcoming = (await deps.interviews()).filter(
    (i) => i.decision === "confirmed" && i.start.getTime() > now.getTime(),
  );
  for (const interview of upcoming) {
    let proposalId = await deps.proposalOf(interview.detectionId);
    if (proposalId === null) {
      const proposed = await deps.propose(interview.detectionId, {
        busy: [],
        workingHours: deps.config.workingHours,
        timeZone: deps.config.timeZone,
        now,
      });
      if (!proposed.ok) {
        r.notProposed++;
        continue;
      }
      r.proposed++;
      proposalId = proposed.value.proposalId;
    }
    // Filing is idempotent: a plan already filed answers its first request.
    const filed = await deps.file(proposalId);
    if (!filed.ok) r.notFiled++;
    else if (filed.value.stored) r.filed++;
    else r.waiting++;
  }
  await writeApproved(deps, r);
  return r;
}

async function writeApproved(deps: PrepRunDeps, r: PrepRunReport): Promise<void> {
  const letters = letterState(await deps.letters(), "calendar.prep_write");
  const all = await deps.approved();
  const plans = all.filter((p) => !letters.passOver.has(p.decisionId));
  r.passedOver = all.length - plans.length;
  // Nothing approved: no consent page for nothing.
  if (plans.length === 0) return;
  let write: PrepWriter;
  try {
    write = await deps.consent();
  } catch (e) {
    r.writeStoppedBy = errorName(e);
    return;
  }
  for (const plan of plans) {
    r.approved++;
    let answer: Result<PrepWritten, PrepRefusal>;
    try {
      answer = await write(plan);
    } catch (e) {
      // Google not answering is about Google, not this plan: stop, with no letter, and a later
      // run continues (the claim's lease lets it). The breaker counts these.
      if (googleDown(e)) {
        r.writeStoppedBy = errorName(e);
        return;
      }
      // The claim stays; the ledger's lease lets a later run continue. Paul sees it in Stuck work.
      const reason: PrepLetterReason =
        errorName(e) === "PrepClaimsExhausted" ? "claims_exhausted" : "write_failed";
      await deps.recordLetter(
        plan,
        reason,
        letterKey("calendar.prep_write", plan.decisionId, letters.count),
      );
      r.stuck++;
      continue;
    }
    if (!answer.ok) {
      r.skipped++;
      continue;
    }
    if (answer.value.kind === "needs_human") {
      // The grant can't write: every other plan would answer the same.
      r.scopeMissing = true;
      return;
    }
    r.written++;
  }
}

// The Calendar writer's own failure (CalendarWriteError) with no answer, a rate limit or a server
// error: Google is down or busy, so every plan would fail the same way.
function googleDown(e: unknown): boolean {
  if (errorName(e) !== "CalendarWriteError") return false;
  const status = (e as { status?: unknown }).status;
  return typeof status === "number" && (status === 0 || status === 429 || status >= 500);
}

export type PrepDeps = {
  print: (line: string) => void;
  runPrep: () => Promise<PrepRunReport>;
};

export async function prepCommand(deps: PrepDeps): Promise<number> {
  let r: PrepRunReport;
  try {
    r = await deps.runPrep();
  } catch (error) {
    deps.print(`Interview prep stopped: ${describeError(error)}`);
    deps.print("What was saved stays; run it again to retry.");
    return 1;
  }
  deps.print(
    `Prep proposed for ${r.proposed} interview(s)${r.notProposed > 0 ? ` (${r.notProposed} couldn't be planned: started, rescheduled or no longer confirmed)` : ""}.`,
  );
  deps.print(
    `Sent to your Queue for approval: ${r.filed}. Sent on an earlier run: ${r.waiting}. Not sent: ${r.notFiled}.`,
  );
  if (r.writeStoppedBy !== null) {
    deps.print(
      `Written to your Northstar calendar: ${r.written}. The rest wasn't: Google's consent didn't finish or Google didn't answer (${r.writeStoppedBy}). Run it again later; nothing is written twice.`,
    );
    return 1;
  }
  if (r.scopeMissing) {
    deps.print(
      "Approved plans weren't written: Google didn't grant calendar access for the Northstar calendar. Allow it on the consent page and run it again.",
    );
    return 1;
  }
  deps.print(
    `Approved plans written to your Northstar calendar: ${r.written} of ${r.approved}. Held back for later: ${r.skipped}.`,
  );
  if (r.stuck + r.passedOver > 0) {
    deps.print(
      `In Stuck work on /health: ${r.stuck} new, ${r.passedOver} waiting for you. Retry one there and the next run writes it.`,
    );
  }
  if (r.filed > 0)
    deps.print("Approve or reject the new plans in your Queue, then run this again.");
  return r.stuck > 0 ? 1 : 0;
}

// Fixed words by the error's class: consent and database errors never echo a token or a value.
function describeError(error: unknown): string {
  const name = errorName(error);
  if (name === "FunnelConfigError" && error instanceof Error) return error.message;
  return `${name} (no details are printed)`;
}
