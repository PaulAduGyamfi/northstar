import type { ThesisProfile } from "@northstar/db";
import type { CallRecord, LlmGateway, LlmOutcome } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import {
  draftTheses,
  positioningThesisRoute,
  renderThesisProfile,
  type ThesisCandidates,
  thesisEvidence,
  thesisProblems,
} from "./thesis-draft.js";

// Synthetic profile (invented employers, public repo).
const profile: ThesisProfile = {
  roles: [
    {
      employer: "Example Payments",
      title: "Software Engineer",
      startMonth: "2021-02",
      endMonth: "2025-04",
      current: false,
    },
    {
      employer: "Sample Labs",
      title: "Founding Engineer",
      startMonth: "2025-06",
      endMonth: null,
      current: true,
    },
  ],
  atoms: [
    {
      id: "atom-1",
      roleId: "role-1",
      quote: "Built card-authorization services handling 3,000 requests per second in Java.",
    },
    {
      id: "atom-2",
      roleId: "role-2",
      quote: "Shipped production AI agents for claims triage with Python.",
    },
  ],
  skills: ["Java", "Python", "Kafka"],
};
const asOf = "2026-11";

const record: CallRecord = {
  route: "positioning-thesis",
  promptId: "positioning-thesis",
  promptVersion: 1,
  modelRequested: "claude-opus-5-5",
  modelServed: "claude-opus-5-5",
  effort: "medium",
  inputTokens: 600,
  outputTokens: 150,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  latencyMs: 1800,
  costUsd: 0.01,
  stopReason: "end_turn",
  refusalCategory: null,
  fallbackUsed: false,
};

function gatewayAnswering(outcome: LlmOutcome<ThesisCandidates> | null) {
  const inputs: ThesisProfile[] = [];
  const gateway: LlmGateway = {
    async call<I, O>(_route: unknown, i: I): Promise<LlmOutcome<O>> {
      inputs.push(i as unknown as ThesisProfile);
      if (!outcome) throw new Error("unexpected model call");
      return outcome as unknown as LlmOutcome<O>;
    },
  };
  return { gateway, inputs };
}

const good = {
  text: "Software engineer with 5 years of payments scale at Example Payments who now ships production AI agents in Python.",
  atomIds: ["atom-1", "atom-2"],
};

describe("thesisEvidence", () => {
  it("quotes only the cited atoms and keeps every role and skill", () => {
    const { evidence, unknown, cited } = thesisEvidence(profile, ["atom-2"], asOf);
    expect([evidence, unknown, cited]).toEqual([
      {
        quotes: ["Shipped production AI agents for claims triage with Python."],
        roles: profile.roles,
        skills: ["Java", "Python", "Kafka"],
        asOf,
      },
      [],
      1,
    ]);
  });

  it("reports an unknown atom id instead of ignoring it", () => {
    const { unknown, cited } = thesisEvidence(profile, ["atom-1", "atom-9", "atom-1"], asOf);
    expect([unknown, cited]).toEqual([["atom-9"], 1]);
  });
});

describe("thesisProblems", () => {
  it("finds nothing wrong with a thesis its atoms back", () => {
    expect(thesisProblems(good, profile, asOf)).toEqual([]);
  });

  it("refuses a thesis that cites only unknown atoms", () => {
    expect(thesisProblems({ text: "Engineer.", atomIds: ["atom-9"] }, profile, asOf)).toEqual([
      { kind: "unknown_atom", id: "atom-9" },
      { kind: "no_citation" },
    ]);
  });

  it("doesn't let an uncited atom back a number", () => {
    const text = "Engineer handling 3,000 requests per second.";
    expect(thesisProblems({ text, atomIds: ["atom-2"] }, profile, asOf)).toEqual([
      { kind: "unbacked_number", token: "3,000" },
    ]);
  });
});

describe("positioningThesisRoute", () => {
  it("puts the profile in one untrusted block with each atom's id", () => {
    const rendered = positioningThesisRoute().render(profile);
    expect(JSON.stringify(rendered.volatile)).toContain("untrusted_data");
    expect(renderThesisProfile(profile)).toBe(
      [
        "Roles:",
        "- Software Engineer, Example Payments (2021-02 to 2025-04)",
        "- Founding Engineer, Sample Labs (2025-06 to now)",
        "Atoms:",
        "[atom-1] Built card-authorization services handling 3,000 requests per second in Java.",
        "[atom-2] Shipped production AI agents for claims triage with Python.",
        "Skills: Java, Python, Kafka",
      ].join("\n"),
    );
  });

  it("refuses more than three candidates", () => {
    const four = { candidates: [good, good, good, good] };
    expect(positioningThesisRoute().output.safeParse(four).success).toBe(false);
  });
});

describe("draftTheses", () => {
  it("is off by default and calls no model", async () => {
    const { gateway, inputs } = gatewayAnswering(null);
    expect([await draftTheses({ gateway }, profile, asOf), inputs.length]).toEqual([
      { kind: "skipped", reason: "off" },
      0,
    ]);
  });

  it("makes no call for a profile with no atoms", async () => {
    const { gateway, inputs } = gatewayAnswering(null);
    const empty = { ...profile, atoms: [] };
    expect([await draftTheses({ gateway, enabled: true }, empty, asOf), inputs.length]).toEqual([
      { kind: "skipped", reason: "no_atoms" },
      0,
    ]);
  });

  it("keeps a passing candidate and drops unbacked numbers, names and unknown atoms", async () => {
    const { gateway } = gatewayAnswering({
      kind: "Ok",
      output: {
        candidates: [
          good,
          {
            text: "Engineer who scaled payments to 10,000 requests per second.",
            atomIds: ["atom-1"],
          },
          { text: "Engineer who ships AI agents at Acme Health.", atomIds: ["atom-2"] },
        ],
      },
      record,
    });
    expect(await draftTheses({ gateway, enabled: true }, profile, asOf)).toEqual({
      kind: "drafted",
      theses: [good],
      dropped: 2,
      record,
    });
  });

  it("drops a candidate that cites an atom the profile doesn't have", async () => {
    const { gateway } = gatewayAnswering({
      kind: "Ok",
      output: {
        candidates: [
          { text: "Engineer who ships AI agents in Python.", atomIds: ["atom-2", "atom-7"] },
        ],
      },
      record,
    });
    expect(await draftTheses({ gateway, enabled: true }, profile, asOf)).toEqual({
      kind: "drafted",
      theses: [],
      dropped: 1,
      record,
    });
  });

  it("reports a refusal without drafting", async () => {
    const { gateway } = gatewayAnswering({ kind: "Refused", category: null, record });
    expect(await draftTheses({ gateway, enabled: true }, profile, asOf)).toEqual({
      kind: "failed",
      reason: "refused",
      record,
    });
  });
});
