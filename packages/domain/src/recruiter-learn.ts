import { RECRUITER_GRADE_REASONS, type RecruiterGradeReason } from "./recruiter-grade.js";

// Learning recruiter grading from Paul's regrades (NS-238 item 3 slice 2, REC-003). Plain code:
// each reason on a grade he regraded collects how far his letter is from the grader's, and a reason
// that enough regrades share gets a small, bounded point adjustment. Recomputed from all of his
// current regrades each time, never added up, so it can't run away.

type Letter = "A" | "B" | "C" | "D" | "F";
const LETTER_VALUE: Record<Letter, number> = { A: 4, B: 3, C: 2, D: 1, F: 0 };

// Caps decide a grade on their own (a dealbreaker or a red flag): they add no points, so there's
// nothing to adjust.
export const ADJUSTABLE_REASONS: readonly RecruiterGradeReason[] = RECRUITER_GRADE_REASONS.filter(
  (r) => r !== "dealbreaker" && !r.startsWith("red_flag:"),
);

// A reason is adjusted only once this many regraded messages carry it.
export const MIN_REGRADES = 3;
// No reason moves a grade by more than this many points either way.
export const MAX_ADJUSTMENT = 2;
// Nor do all of a grade's adjustments together: a message carries about six adjustable reasons, so
// without this a learned lean could swing a grade across the whole A–F scale.
export const MAX_TOTAL_ADJUSTMENT = 2;

export type RegradeSample = {
  // The stored grade's reasons and letter, and Paul's current letter for the same message.
  reasons: readonly string[];
  systemGrade: string;
  paulGrade: string;
};

export type RecruiterWeights = Partial<Record<RecruiterGradeReason, number>>;

const isLetter = (l: string): l is Letter => Object.hasOwn(LETTER_VALUE, l);

export function learnRecruiterWeights(samples: readonly RegradeSample[]): RecruiterWeights {
  const deltas = new Map<RecruiterGradeReason, number[]>();
  for (const s of samples) {
    if (!isLetter(s.systemGrade) || !isLetter(s.paulGrade)) continue;
    // Positive: Paul likes it more than the grader did.
    const delta = LETTER_VALUE[s.paulGrade] - LETTER_VALUE[s.systemGrade];
    // Each reason counts once per message.
    for (const reason of new Set(s.reasons)) {
      if (!(ADJUSTABLE_REASONS as readonly string[]).includes(reason)) continue;
      const r = reason as RecruiterGradeReason;
      deltas.set(r, [...(deltas.get(r) ?? []), delta]);
    }
  }
  const weights: RecruiterWeights = {};
  // In the list's order, so the same samples always give the same object.
  for (const r of ADJUSTABLE_REASONS) {
    const ds = deltas.get(r);
    if (!ds || ds.length < MIN_REGRADES) continue;
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    // Math.round rounds -0.5 up to -0, so round the size and keep the sign.
    const rounded = Math.sign(mean) * Math.round(Math.abs(mean));
    const held = Math.max(-MAX_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, rounded));
    if (held !== 0) weights[r] = held;
  }
  return weights;
}
