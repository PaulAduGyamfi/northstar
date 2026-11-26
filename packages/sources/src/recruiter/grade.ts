import type { PreferenceValues, ScorableJob } from "@northstar/db";
import { dealbreakerIn, payCheck, placeCheck, titleFit } from "../fit/score.js";

// Grading a recruiter's message A–F (REC-001, REC-002, NS-167). Plain code: the model only read
// the email's facts (@northstar/inbox's recruiter-extract route, checked against the email), and
// this decides the grade from Paul's search preferences with the same checks as the Fit Score.
// The points and caps are a first guess until Paul's own grades tune them (REC-001's target).

// The checked facts from @northstar/inbox (RecruiterFacts). Repeated here as a shape so this
// package doesn't depend on the inbox.
export type RecruiterFactsInput = {
  roleTitle: string | null;
  seniority: string | null;
  company: string | null;
  location: string | null;
  remote: "onsite" | "hybrid" | "remote" | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: "year" | "month" | "hour" | null;
  agency: boolean | null;
  personalizedQuote: string | null;
  redFlags: readonly { kind: "upfront_fee" | "sensitive_data" | "vague_role" | "unpaid_work" }[];
};

export type Grade = "A" | "B" | "C" | "D" | "F";

// One reason per factor, as `<factor>:<outcome>`: codes only, never email text, so a reason can
// go into an event or the app as is.
export type GradeReason =
  | `title:${"exact" | "partial" | "none" | "unknown"}`
  | "title:level_mismatch"
  | `pay:${"ok" | "below" | "unknown"}`
  | `place:${"ok" | "mismatch" | "unknown"}`
  | `sender:${"agency" | "in_house" | "unknown"}`
  | `personal:${"yes" | "no"}`
  | `company:${"named" | "unnamed"}`
  | "dealbreaker"
  | `red_flag:${"upfront_fee" | "sensitive_data" | "vague_role" | "unpaid_work"}`;

export type RecruiterGrade = {
  grade: Grade;
  points: number;
  reasons: GradeReason[];
  // low: two or more of title, pay and place are unknown, so the grade rests on little.
  confidence: "normal" | "low";
};

const TITLE_POINTS = { exact: 3, partial: 1, none: -2, unknown: 0 } as const;
const PAY_POINTS = { ok: 2, below: -3, unknown: 0 } as const;
const PLACE_POINTS = { ok: 1, mismatch: -3, unknown: 0 } as const;
// Red flags that end the matter: someone asking for money or ID is not a real recruiter.
const FATAL_FLAGS = new Set(["upfront_fee", "sensitive_data"]);

const ORDER: Grade[] = ["A", "B", "C", "D", "F"];
const worse = (a: Grade, b: Grade): Grade => (ORDER.indexOf(a) > ORDER.indexOf(b) ? a : b);

function gradeFor(points: number): Grade {
  if (points >= 5) return "A";
  if (points >= 3) return "B";
  if (points >= 1) return "C";
  if (points >= -1) return "D";
  return "F";
}

export function gradeRecruiterMessage(
  facts: RecruiterFactsInput,
  prefs: PreferenceValues,
  // The email as the route saw it. Dealbreakers are matched against it too, so leaving a fact
  // out ("a crypto exchange" with no company) can't dodge one. It is only matched, never kept.
  email = "",
): RecruiterGrade {
  // The facts as a job, so the Fit Score's own checks read them.
  const job: ScorableJob = {
    id: "recruiter-message",
    title: facts.roleTitle,
    location: facts.location,
    remote: facts.remote,
    salaryMin: facts.salaryMin,
    salaryMax: facts.salaryMax,
    salaryCurrency: facts.salaryCurrency,
    salaryPeriod: facts.salaryPeriod,
    seniority: facts.seniority,
    requirements: [],
    niceToHaves: [],
    // Dealbreakers are matched against the stated facts and the email itself.
    description:
      [facts.company, facts.location, facts.seniority, email].filter(Boolean).join("\n") || null,
  };
  const [, title] = titleFit(job, prefs);
  const pay = payCheck(job, prefs);
  const place = placeCheck(job, prefs);

  const reasons: GradeReason[] = [`title:${title.status}`];
  let points = TITLE_POINTS[title.status];
  if (title.levelMismatch) {
    reasons.push("title:level_mismatch");
    points -= 1;
  }
  reasons.push(`pay:${pay.status}`, `place:${place.status}`);
  points += PAY_POINTS[pay.status] + PLACE_POINTS[place.status];

  reasons.push(
    facts.agency === null ? "sender:unknown" : facts.agency ? "sender:agency" : "sender:in_house",
  );
  if (facts.agency === true) points -= 1;
  reasons.push(facts.personalizedQuote === null ? "personal:no" : "personal:yes");
  if (facts.personalizedQuote !== null) points += 1;
  reasons.push(facts.company === null ? "company:unnamed" : "company:named");
  if (facts.company === null) points -= 1;

  let grade = gradeFor(points);
  if (dealbreakerIn(job, prefs) !== null) {
    reasons.push("dealbreaker");
    grade = "F";
  }
  for (const kind of new Set(facts.redFlags.map((f) => f.kind))) {
    reasons.push(`red_flag:${kind}`);
    grade = worse(grade, FATAL_FLAGS.has(kind) ? "F" : "D");
  }

  const unknowns = [title.status, pay.status, place.status].filter((s) => s === "unknown").length;
  return { grade, points, reasons, confidence: unknowns >= 2 ? "low" : "normal" };
}
