import { z } from "zod";
import { err, ok, type Result } from "./result.js";

// The Approval Gate's plain-code half (ADR-0002, NS-119): what can wait for Paul, the facts a
// policy may look at, Paul's auto-approve rules and the evaluator. No model, no I/O: code decides
// whether something may go out, never an LLM.

// Everything that needs a human, in one queue (APR-001).
export const APPROVAL_KINDS = [
  "application_package",
  "answer",
  "email_reply",
  "outreach",
  "profile_fix",
  "growth_plan",
  "prep_plan",
] as const;
export const ApprovalKind = z.enum(APPROVAL_KINDS);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

// Only application packages may ever be auto-approved (APPLY-004). New answers (ANS-005), email
// replies (RPL-002) and outreach (OUT-005) always need Paul; so do profile PRs and plans.
const AUTO_APPROVABLE: ReadonlySet<ApprovalKind> = new Set(["application_package"]);

// Every decision takes effect this long after it is made; until then Paul can undo it (UX-016,
// design research brief: ~2 min "undo send" before submit).
export const UNDO_WINDOW_MS = 2 * 60 * 1000;

// What a producer tells the Gate about an application package. Numbers and flags only: never
// answer text, job titles or company names, since facts are stored with the request.
export const PackageFacts = z
  .object({
    // The fit score (NS-116), 0-100; null until scoring exists for this job.
    fit: z.number().min(0).max(100).nullable(),
    // `known`: a deterministic ATS adapter; `generic`: the LLM-guided form filler (APPLY-003).
    adapter: z.enum(["known", "generic"]),
    // A form shape seen before. First-time forms always need Paul (APPLY-003).
    formSeenBefore: z.boolean(),
    answers: z.array(
      z
        .object({
          source: z.enum(["bank_exact", "bank_high_confidence", "new"]),
          // Length of a free-text answer in words; 0 for a choice or a short field.
          freeTextWords: z.number().int().min(0),
        })
        .strict(),
    ),
  })
  .strict();
export type PackageFacts = z.infer<typeof PackageFacts>;

// One of Paul's auto-approve rules (APPLY-004). A known adapter and a form seen before are always
// required and not configurable: those are the APPLY-003 floor, not a preference.
export const PolicyRule = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.literal("application_package"),
    minFit: z.number().int().min(0).max(100),
    // Also accept answers the bank matched with high confidence, not only exact reuse.
    allowHighConfidenceAnswers: z.boolean(),
    maxFreeTextWords: z.number().int().min(0).max(1000),
  })
  .strict();
export type PolicyRule = z.infer<typeof PolicyRule>;

// A whole set of rules, saved and replaced together. Names identify the rule in decisions and in
// the feed, so they must be unique.
export const PolicySet = z
  .array(PolicyRule)
  .max(20)
  .refine((rules) => new Set(rules.map((r) => r.name)).size === rules.length, {
    message: "rule names must be unique",
  });

export type InvalidPolicySet = { kind: "InvalidPolicySet"; fields: string[] };

// Checks a policy set before anything stores it. The error names the bad fields, never values.
export function parsePolicySet(input: unknown): Result<PolicyRule[], InvalidPolicySet> {
  const parsed = PolicySet.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
  return err({ kind: "InvalidPolicySet", fields });
}

export type PolicyCondition =
  | "fit"
  | "adapter"
  | "form_seen_before"
  | "answers_reused"
  | "free_text_length";

export type PolicyOutcome =
  | { auto: true; rule: string }
  | {
      auto: false;
      // Why it waits for Paul, for the feed: a fixed reason, or each rule's failed conditions.
      why:
        | "no_policies"
        | "never_auto"
        | "missing_facts"
        // Set by the Gate, not the evaluator: Paul rejected or undid this subject before, so a
        // new request for it always waits for him.
        | "declined_before"
        | { rule: string; failed: PolicyCondition[] }[];
    };

// Decides whether a request may skip Paul. Default is always "wait": only an application package
// with facts that satisfy every condition of at least one rule is auto-approved. The first
// matching rule wins.
export function evaluatePolicies(
  kind: ApprovalKind,
  facts: PackageFacts | null,
  rules: readonly PolicyRule[],
): PolicyOutcome {
  if (!AUTO_APPROVABLE.has(kind)) return { auto: false, why: "never_auto" };
  if (rules.length === 0) return { auto: false, why: "no_policies" };
  if (facts === null) return { auto: false, why: "missing_facts" };
  const misses: { rule: string; failed: PolicyCondition[] }[] = [];
  for (const rule of rules) {
    const failed = failedConditions(rule, facts);
    if (failed.length === 0) return { auto: true, rule: rule.name };
    misses.push({ rule: rule.name, failed });
  }
  return { auto: false, why: misses };
}

function failedConditions(rule: PolicyRule, facts: PackageFacts): PolicyCondition[] {
  const failed: PolicyCondition[] = [];
  // No score yet counts as a miss: a missing fact never approves.
  if (facts.fit === null || facts.fit < rule.minFit) failed.push("fit");
  if (facts.adapter !== "known") failed.push("adapter");
  if (!facts.formSeenBefore) failed.push("form_seen_before");
  const reused = facts.answers.every(
    (a) =>
      a.source === "bank_exact" ||
      (rule.allowHighConfidenceAnswers && a.source === "bank_high_confidence"),
  );
  if (!reused) failed.push("answers_reused");
  if (facts.answers.some((a) => a.freeTextWords > rule.maxFreeTextWords)) {
    failed.push("free_text_length");
  }
  return failed;
}
