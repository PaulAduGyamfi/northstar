import type { ScoringProfile } from "@northstar/db";
import type { CallRecord, LlmGateway, LlmOutcome } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import type { Unmatched } from "./match.js";
import {
  assistUnmatched,
  checkJobMatches,
  type JobMatchInput,
  type JobMatchOutput,
  jobMatchInput,
  jobMatchRoute,
} from "./model-match.js";

// Synthetic atoms and requirements only.

const profile: ScoringProfile = {
  sourceId: "source-1",
  atoms: [
    { id: "atom-1", what: "Led a team of 4 engineers for 6 years", how: ["Go"] },
    { id: "atom-2", what: "Wrote the design docs for the billing platform", how: [] },
  ],
  skills: ["Go"],
};
const unmatched: Unmatched[] = [
  { requirement: "5+ years leading engineering teams", kind: "must" },
  { requirement: "Strong written communication", kind: "must" },
  { requirement: "Experience with healthcare data", kind: "nice" },
];
const input = jobMatchInput(unmatched, profile);

const record: CallRecord = {
  route: "job-match",
  promptId: "job-match",
  promptVersion: 1,
  modelRequested: "claude-opus-5-5",
  modelServed: "claude-opus-5-5",
  effort: "medium",
  inputTokens: 800,
  outputTokens: 120,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  latencyMs: 2000,
  costUsd: 0.01,
  stopReason: "end_turn",
  refusalCategory: null,
  fallbackUsed: false,
};

function gatewayAnswering(outcome: LlmOutcome<JobMatchOutput> | null) {
  const inputs: JobMatchInput[] = [];
  const gateway: LlmGateway = {
    async call<I, O>(_route: unknown, i: I): Promise<LlmOutcome<O>> {
      inputs.push(i as unknown as JobMatchInput);
      if (!outcome) throw new Error("unexpected model call");
      return outcome as unknown as LlmOutcome<O>;
    },
  };
  return { gateway, inputs };
}

const proposal = (matches: JobMatchOutput["matches"]): JobMatchOutput => ({ matches });

describe("checkJobMatches", () => {
  it("keeps a proposal whose quote is verbatim in its atom", () => {
    const out = proposal([
      { requirement: 0, atomId: "atom-1", quote: "Led a team of 4 engineers" },
    ]);
    expect(checkJobMatches(out, input)).toEqual([
      {
        requirement: "5+ years leading engineering teams",
        atomId: "atom-1",
        quote: "Led a team of 4 engineers",
      },
    ]);
  });

  it("drops a quote that isn't in the atom, even one from the requirement", () => {
    const out = proposal([
      { requirement: 1, atomId: "atom-2", quote: "Strong written communication" },
      { requirement: 0, atomId: "atom-2", quote: "Led a team" },
    ]);
    expect(checkJobMatches(out, input)).toEqual([]);
  });

  it("drops an atom id the input didn't send", () => {
    const out = proposal([{ requirement: 0, atomId: "atom-9", quote: "Led a team" }]);
    expect(checkJobMatches(out, input)).toEqual([]);
  });

  it("drops a requirement index the input didn't send", () => {
    const out = proposal([{ requirement: 7, atomId: "atom-1", quote: "Led a team" }]);
    expect(checkJobMatches(out, input)).toEqual([]);
  });

  it.each(["the", "Led", "the design", "ead a tea", "of 4 eng"])(
    "drops %j: a quote must be at least two whole words, not only small words",
    (quote) => {
      const out = proposal([{ requirement: 0, atomId: "atom-1", quote }]);
      expect(checkJobMatches(out, input)).toEqual([]);
    },
  );

  it("drops a quote of fewer than three characters", () => {
    const out = proposal([{ requirement: 0, atomId: "atom-1", quote: "Le" }]);
    expect(checkJobMatches(out, input)).toEqual([]);
  });

  it("drops a quote that runs across the atom's line and its terms", () => {
    const out = proposal([{ requirement: 0, atomId: "atom-1", quote: "for 6 years (Go" }]);
    expect(checkJobMatches(out, input)).toEqual([]);
  });

  it("keeps a quote that is one of the atom's terms when it is two words", () => {
    const withTerm = jobMatchInput(unmatched, {
      ...profile,
      atoms: [{ id: "atom-3", what: "Ran the clusters", how: ["Google Cloud"] }],
    });
    const out = proposal([{ requirement: 0, atomId: "atom-3", quote: "Google Cloud" }]);
    expect(checkJobMatches(out, withTerm).map((m) => m.quote)).toEqual(["Google Cloud"]);
  });

  it("keeps a requirement's first proposal only, and ignores nulls", () => {
    const out = proposal([
      { requirement: 1, atomId: null, quote: null },
      { requirement: 1, atomId: "atom-2", quote: "Wrote the design docs" },
      { requirement: 1, atomId: "atom-1", quote: "Led a team" },
    ]);
    expect(checkJobMatches(out, input).map((m) => m.quote)).toEqual(["Wrote the design docs"]);
  });

  it("accepts a quote that differs from the atom only in whitespace", () => {
    const out = proposal([{ requirement: 0, atomId: "atom-1", quote: "Led  a team\nof 4" }]);
    expect(checkJobMatches(out, input).map((m) => m.quote)).toEqual(["Led a team of 4"]);
  });
});

describe("assistUnmatched", () => {
  it("is off by default and calls no model", async () => {
    const { gateway, inputs } = gatewayAnswering(null);
    expect([await assistUnmatched({ gateway }, unmatched, profile), inputs.length]).toEqual([
      { kind: "skipped", reason: "off" },
      0,
    ]);
  });

  it("makes no call when nothing is unmatched", async () => {
    const { gateway, inputs } = gatewayAnswering(null);
    const result = await assistUnmatched({ gateway, enabled: true }, [], profile);
    expect([result, inputs.length]).toEqual([{ kind: "skipped", reason: "nothing" }, 0]);
  });

  it("sends only the unmatched requirements and keeps what checks out", async () => {
    const { gateway, inputs } = gatewayAnswering({
      kind: "Ok",
      output: proposal([
        { requirement: 0, atomId: "atom-1", quote: "for 6 years" },
        { requirement: 2, atomId: "atom-2", quote: "healthcare" },
      ]),
      record,
    });
    const result = await assistUnmatched({ gateway, enabled: true }, unmatched, profile);
    expect([inputs[0]?.requirements, result]).toEqual([
      unmatched.map((u) => u.requirement),
      {
        kind: "assisted",
        matches: [
          {
            requirement: "5+ years leading engineering teams",
            atomId: "atom-1",
            quote: "for 6 years",
            stamp: "job-match/v1 claude-opus-5-5",
          },
        ],
        record,
      },
    ]);
  });

  it.each([
    [{ kind: "Refused", category: null, record } as const, "refused"],
    [{ kind: "Truncated", record } as const, "truncated"],
    [{ kind: "InvalidOutput", issues: [], record } as const, "invalid_output"],
  ])("reports a %s outcome as failed", async (outcome, reason) => {
    const { gateway } = gatewayAnswering(outcome as unknown as LlmOutcome<JobMatchOutput>);
    expect(await assistUnmatched({ gateway, enabled: true }, unmatched, profile)).toEqual({
      kind: "failed",
      reason,
      record,
    });
  });
});

describe("jobMatchRoute", () => {
  it("puts requirements and atoms in untrusted blocks, nothing in the stable part", () => {
    const rendered = jobMatchRoute().render(input);
    expect([
      rendered.stable,
      rendered.volatile.includes('<untrusted_data kind="requirements">'),
      rendered.volatile.includes('<untrusted_data kind="atoms">'),
      rendered.volatile.includes("[0] 5+ years leading engineering teams"),
      rendered.volatile.includes("[atom-1] Led a team of 4 engineers for 6 years (Go)"),
    ]).toEqual([[], true, true, true, true]);
  });
});
