import { describe, expect, it } from "vitest";
import {
  APPROVAL_KINDS,
  evaluatePolicies,
  type PackageFacts,
  type PolicyRule,
  parsePolicySet,
} from "./approval.js";

// A package every rule below would auto-approve; each test spoils one fact.
const good: PackageFacts = {
  fit: 91,
  adapter: "known",
  formSeenBefore: true,
  answers: [
    { source: "bank_exact", freeTextWords: 40 },
    { source: "bank_exact", freeTextWords: 0 },
  ],
};

const rule: PolicyRule = {
  name: "strong fit, reused answers",
  kind: "application_package",
  minFit: 85,
  allowHighConfidenceAnswers: false,
  maxFreeTextWords: 100,
};

describe("evaluatePolicies", () => {
  it("auto-approves a package that meets every condition of a rule", () => {
    expect(evaluatePolicies("application_package", good, [rule])).toEqual({
      auto: true,
      rule: "strong fit, reused answers",
    });
  });

  it("waits for Paul when there are no policies", () => {
    expect(evaluatePolicies("application_package", good, [])).toEqual({
      auto: false,
      why: "no_policies",
    });
  });

  it("waits for Paul on every kind other than an application package", () => {
    for (const kind of APPROVAL_KINDS.filter((k) => k !== "application_package")) {
      expect(evaluatePolicies(kind, good, [rule])).toEqual({ auto: false, why: "never_auto" });
    }
  });

  it("waits for Paul when the package has no facts", () => {
    expect(evaluatePolicies("application_package", null, [rule])).toEqual({
      auto: false,
      why: "missing_facts",
    });
  });

  it("names a fit below the minimum", () => {
    expect(evaluatePolicies("application_package", { ...good, fit: 84 }, [rule])).toEqual({
      auto: false,
      why: [{ rule: rule.name, failed: ["fit"] }],
    });
  });

  it("treats a missing fit score as failing the fit condition", () => {
    expect(evaluatePolicies("application_package", { ...good, fit: null }, [rule])).toEqual({
      auto: false,
      why: [{ rule: rule.name, failed: ["fit"] }],
    });
  });

  it("names the generic adapter", () => {
    expect(
      evaluatePolicies("application_package", { ...good, adapter: "generic" }, [rule]),
    ).toEqual({ auto: false, why: [{ rule: rule.name, failed: ["adapter"] }] });
  });

  it("names a form shape never seen before", () => {
    expect(
      evaluatePolicies("application_package", { ...good, formSeenBefore: false }, [rule]),
    ).toEqual({ auto: false, why: [{ rule: rule.name, failed: ["form_seen_before"] }] });
  });

  it("names a new answer", () => {
    const facts = { ...good, answers: [{ source: "new" as const, freeTextWords: 10 }] };
    expect(evaluatePolicies("application_package", facts, [rule])).toEqual({
      auto: false,
      why: [{ rule: rule.name, failed: ["answers_reused"] }],
    });
  });

  it("refuses a high-confidence answer unless the rule allows it", () => {
    const facts = {
      ...good,
      answers: [{ source: "bank_high_confidence" as const, freeTextWords: 10 }],
    };
    expect(evaluatePolicies("application_package", facts, [rule])).toEqual({
      auto: false,
      why: [{ rule: rule.name, failed: ["answers_reused"] }],
    });
    expect(
      evaluatePolicies("application_package", facts, [
        { ...rule, allowHighConfidenceAnswers: true },
      ]),
    ).toEqual({ auto: true, rule: rule.name });
  });

  it("names a free-text answer longer than the limit", () => {
    const facts = { ...good, answers: [{ source: "bank_exact" as const, freeTextWords: 101 }] };
    expect(evaluatePolicies("application_package", facts, [rule])).toEqual({
      auto: false,
      why: [{ rule: rule.name, failed: ["free_text_length"] }],
    });
  });

  it("uses the first rule that matches and reports every rule that failed", () => {
    const strict = { ...rule, name: "strict", minFit: 95 };
    const loose = { ...rule, name: "loose", minFit: 90 };
    expect(evaluatePolicies("application_package", good, [strict, loose])).toEqual({
      auto: true,
      rule: "loose",
    });
    expect(evaluatePolicies("application_package", { ...good, fit: 80 }, [strict, loose])).toEqual({
      auto: false,
      why: [
        { rule: "strict", failed: ["fit"] },
        { rule: "loose", failed: ["fit"] },
      ],
    });
  });
});

describe("parsePolicySet", () => {
  it("accepts a valid set", () => {
    expect(parsePolicySet([rule])).toEqual({ ok: true, value: [rule] });
  });

  it("refuses a rule for any kind other than an application package", () => {
    const result = parsePolicySet([{ ...rule, kind: "email_reply" }]);
    expect(result).toEqual({ ok: false, error: { kind: "InvalidPolicySet", fields: ["0.kind"] } });
  });

  it("refuses two rules with the same name", () => {
    const result = parsePolicySet([rule, { ...rule, minFit: 90 }]);
    expect(result).toEqual({ ok: false, error: { kind: "InvalidPolicySet", fields: [""] } });
  });

  it("refuses a minimum fit above 100", () => {
    const result = parsePolicySet([{ ...rule, minFit: 101 }]);
    expect(result).toEqual({
      ok: false,
      error: { kind: "InvalidPolicySet", fields: ["0.minFit"] },
    });
  });
});
