import { z } from "zod";
import type { EvalReport } from "./types.js";

// evals/<route>/baseline.json: the last accepted live result (ADR-0013).
export const Baseline = z
  .object({
    passed: z.number().int().min(0),
    total: z.number().int().min(1),
    model: z.string().min(1),
    promptVersion: z.number().int().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();
export type Baseline = z.infer<typeof Baseline>;

// The eval gate: fewer passes than the baseline fails, and so does a changed case count
// (the old baseline no longer describes these cases).
export function compareToBaseline(
  report: EvalReport,
  baseline: Baseline,
): { pass: boolean; line: string } {
  const head = `${report.route}: ${report.passed}/${report.total} passed, baseline ${baseline.passed}/${baseline.total}`;
  if (report.total !== baseline.total) {
    return { pass: false, line: `${head}: CASE COUNT CHANGED, re-baseline with --live` };
  }
  if (report.passed < baseline.passed) {
    return { pass: false, line: `${head}: BELOW BASELINE` };
  }
  return { pass: true, line: `${head}: ok` };
}
