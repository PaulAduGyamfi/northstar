import {
  DEFAULT_MODEL,
  type LlmGateway,
  LlmTransportError,
  MissingFixture,
  type Route,
} from "@northstar/llm";
import { z } from "zod";
import type { Grader } from "./graders.js";

export type CaseResult = { id: string; outcome: string; passed: boolean };

export type EvalReport = {
  route: string;
  promptVersion: number;
  model: string;
  passed: number;
  total: number;
  inputTokens: number;
  outputTokens: number;
  // null if any call's model had no known price.
  costUsd: number | null;
  cases: CaseResult[];
};

// An eval set with its types erased, so the CLI can keep many in one registry.
export type RegisteredEval = {
  name: string;
  // Validates and runs raw cases (as read from cases.jsonl).
  run(gateway: LlmGateway, rawCases: readonly unknown[]): Promise<EvalReport>;
};

// Rounds to millionths of a cent, so summed float costs print as exact decimals.
const roundUsd = (usd: number) => Math.round(usd * 1e8) / 1e8;

export function defineEval<I, O, E>(spec: {
  route: Route<I, O>;
  inputSchema: z.ZodType<I>;
  expectedSchema: z.ZodType<E>;
  grader: Grader;
}): RegisteredEval {
  const caseSchema = z.object({
    id: z.string().min(1),
    input: spec.inputSchema,
    expected: spec.expectedSchema,
  });

  return {
    name: spec.route.name,
    async run(gateway, rawCases) {
      const report: EvalReport = {
        route: spec.route.name,
        promptVersion: spec.route.prompt.version,
        model: spec.route.model ?? DEFAULT_MODEL,
        passed: 0,
        total: rawCases.length,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        cases: [],
      };

      // One at a time: evals are small, and order keeps the output readable.
      for (const [index, raw] of rawCases.entries()) {
        const parsed = caseSchema.safeParse(raw);
        if (!parsed.success) {
          throw new Error(`eval case ${index + 1} does not match the case schema`);
        }
        const testCase = parsed.data;
        const result = await runCase(gateway, spec.route, testCase, spec.grader);
        report.cases.push(result.caseResult);
        if (result.caseResult.passed) report.passed += 1;
        if (result.record) {
          report.inputTokens += result.record.inputTokens;
          report.outputTokens += result.record.outputTokens;
          report.costUsd =
            report.costUsd === null || result.record.costUsd === null
              ? null
              : roundUsd(report.costUsd + result.record.costUsd);
        }
      }
      return report;
    },
  };
}

async function runCase<I, O, E>(
  gateway: LlmGateway,
  route: Route<I, O>,
  testCase: { id: string; input: I; expected: E },
  grader: Grader,
) {
  try {
    const outcome = await gateway.call(route, testCase.input);
    const passed =
      outcome.kind === "Ok" && grader(outcome.output, testCase.expected, testCase.input);
    return {
      caseResult: { id: testCase.id, outcome: outcome.kind, passed },
      record: outcome.record,
    };
  } catch (error) {
    // A missing recording or an API failure fails this case, visibly, and the run continues.
    // A missing fixture names its key, so the line says exactly what to re-record.
    if (error instanceof MissingFixture) {
      const outcome = `${error.name} ${error.key}`;
      return { caseResult: { id: testCase.id, outcome, passed: false }, record: null };
    }
    if (error instanceof LlmTransportError) {
      return { caseResult: { id: testCase.id, outcome: error.name, passed: false }, record: null };
    }
    throw error;
  }
}
