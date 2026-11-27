import type { UnclassifiedMail } from "@northstar/db";
import type { FullMessage, RecruiterExtractResult } from "@northstar/inbox";
import { dependencyDown, errorName, type LetterRow, letterKey, letterState } from "./inbox.js";

// Grading recruiter mail in `funnel inbox` (NS-238 item 1 slice 2, REC-001): the route reads the
// facts, `checkRecruiterFacts` keeps only what the email states, and plain code grades them. The
// grade stored is the grader's own, with no learned weights, so learning keeps measuring against
// it. Off unless Paul turns on RECRUITER_EXTRACT. Codes and counts only leave this file.

// Grades a run makes at most: each is a normal-priority model call.
export const MAX_GRADE = 10;

export type GradeLetterReason =
  | "refused"
  | "truncated"
  | "invalid_output"
  | "read_failed"
  | "grade_failed"
  | "record_refused";

// The grade as stored: the grader's letter, points, reason codes and confidence.
export type StoredGrade = {
  grade: string;
  points: number;
  reasons: readonly string[];
  confidence: string;
};

export type GradingDeps = {
  enabled: boolean;
  // Every `mail.grade` letter with Paul's resolution (readDeadLetterKeys).
  gradeLetters: () => Promise<readonly LetterRow[]>;
  ungraded: (limit: number) => Promise<readonly UnclassifiedMail[]>;
  readFull: (gmailMessageId: string) => Promise<FullMessage>;
  // extractRecruiterFacts, with the route turned on.
  extract: (body: string) => Promise<RecruiterExtractResult>;
  // gradeRecruiterMessage over the checked facts and Paul's current preferences, no weights.
  grade: (
    facts: Extract<RecruiterExtractResult, { kind: "extracted" }>["facts"],
    body: string,
  ) => Promise<StoredGrade>;
  record: (gmailMessageId: string, grade: StoredGrade) => Promise<{ ok: boolean }>;
  recordGradeLetter: (
    mail: UnclassifiedMail,
    reason: GradeLetterReason,
    key: string,
  ) => Promise<void>;
};

export type GradingReport = {
  enabled: boolean;
  graded: number;
  gradeLetters: number;
  gradeStoppedBy: string | null;
  // Ungraded recruiter mail is left for a later run.
  moreToGrade: boolean;
};

export async function runGrading(deps: GradingDeps): Promise<GradingReport> {
  const r: GradingReport = {
    enabled: deps.enabled,
    graded: 0,
    gradeLetters: 0,
    gradeStoppedBy: null,
    moreToGrade: false,
  };
  // Off: nothing is read or sent; the caller counts what waits.
  if (!deps.enabled) return r;
  const letters = letterState(await deps.gradeLetters(), "mail.grade");
  const rows = (await deps.ungraded(MAX_GRADE + letters.passOver.size + 1)).filter(
    (m) => !letters.passOver.has(m.gmailMessageId),
  );
  const giveUp = async (m: UnclassifiedMail, reason: GradeLetterReason) => {
    await deps.recordGradeLetter(
      m,
      reason,
      letterKey("mail.grade", m.gmailMessageId, letters.count),
    );
    r.gradeLetters++;
  };
  let done = 0;
  for (const m of rows.slice(0, MAX_GRADE)) {
    let mail: FullMessage;
    try {
      mail = await deps.readFull(m.gmailMessageId);
    } catch (e) {
      if (dependencyDown(e)) {
        r.gradeStoppedBy = errorName(e);
        break;
      }
      await giveUp(m, "read_failed");
      done++;
      continue;
    }
    let result: RecruiterExtractResult;
    try {
      result = await deps.extract(mail.body);
    } catch (e) {
      if (dependencyDown(e)) {
        r.gradeStoppedBy = errorName(e);
        break;
      }
      await giveUp(m, "grade_failed");
      done++;
      continue;
    }
    if (result.kind === "off") {
      // The route was off after all (a config mismatch): stop rather than letter every message.
      r.gradeStoppedBy = "RecruiterExtractOff";
      break;
    }
    done++;
    if (result.kind === "needs_human") {
      await giveUp(m, result.reason);
      continue;
    }
    let grade: StoredGrade;
    try {
      grade = await deps.grade(result.facts, mail.body);
    } catch {
      await giveUp(m, "grade_failed");
      continue;
    }
    const saved = await deps.record(m.gmailMessageId, grade);
    if (!saved.ok) {
      await giveUp(m, "record_refused");
      continue;
    }
    r.graded++;
  }
  r.moreToGrade = rows.length > done;
  return r;
}
