import type { LinkCandidateRow } from "@northstar/db";
import {
  CalendarError,
  type DetectionRunReport,
  type InterviewCandidate,
  OAuthError,
} from "@northstar/inbox";

// `funnel interviews` (NS-240 slice 6, CAL-002): read the calendar once, with Paul's consent on
// this run (ADR-0026: no stored token), and store the interviews it finds for his confirm step.
// It lives here because this package already depends on both @northstar/inbox and @northstar/db.
// Output is counts only: never an event's title, a time, an address or a name.

export type InterviewsRun = {
  report: DetectionRunReport;
  // Open applications read, and how many have company domains Paul entered (`jobs domains`).
  applications: number;
  withDomains: number;
};

export type InterviewsDeps = {
  print: (line: string) => void;
  runInterviews: () => Promise<InterviewsRun>;
};

// Open applications as detection candidates: active from their creation with no end (only open
// ones are read), matched by Paul's own company domains only (none set: nothing can match).
export function toInterviewCandidates(rows: readonly LinkCandidateRow[]): InterviewCandidate[] {
  return rows.map((row) => ({
    applicationId: row.applicationId,
    companyDomains: row.companyDomains ?? [],
    activeFrom: row.createdAt,
    activeUntil: null,
  }));
}

// Where a stopped run stopped, in words.
const STOPPED: Record<NonNullable<DetectionRunReport["stoppedBy"]>, string> = {
  read: "reading the calendar or your applications failed",
  record: "saving an interview failed",
  dead_letter: "recording a refused interview failed",
};

export async function interviewsCommand(deps: InterviewsDeps): Promise<number> {
  let run: InterviewsRun;
  try {
    run = await deps.runInterviews();
  } catch (error) {
    deps.print(`Interview detection stopped: ${describeError(error)}`);
    deps.print("Nothing more was read; run it again to retry.");
    return 1;
  }
  const r = run.report;
  if (run.withDomains === 0) {
    deps.print(
      `None of your ${run.applications} open application(s) has a company mail domain, so no invite can match. Add them with \`jobs domains add <company-id> <domain>\`.`,
    );
  }
  deps.print(
    `Read ${r.events} calendar event(s) in the next 30 days. Interviews found: ${r.interviews} (${r.recorded} new, ${r.unchanged} unchanged).`,
  );
  deps.print(
    `Not matched: ${r.noMatch}. Matched more than one application: ${r.ambiguous}. Not an interview: ${r.notInterview}. Cancelled: ${r.cancelled}.`,
  );
  const refused = r.tooManyChanges + r.dailyLimit + r.skipped;
  if (refused > 0) {
    deps.print(
      `Not saved: ${refused} (moved too often ${r.tooManyChanges}, daily limit ${r.dailyLimit}, other ${r.skipped}). Each is in Stuck work on /health.`,
    );
  }
  if (r.stoppedBy !== null) {
    deps.print(`Stopped early: ${STOPPED[r.stoppedBy]}. What was saved stays; run it again later.`);
    return 1;
  }
  if (r.recorded > 0) deps.print("Confirm or dismiss them on /interviews.");
  return 0;
}

// Consent and Calendar errors carry fixed words and a status, never a token or an event's text;
// anything else is named only, since its message might quote a row or a response.
function describeError(error: unknown): string {
  if (error instanceof OAuthError || error instanceof CalendarError) return error.message;
  return error instanceof Error ? error.name : "an unknown error";
}
