import {
  type CandidateId,
  type PackageFacts,
  packageSha256,
  packageSubject,
  parsePackage,
} from "@northstar/domain";
import { and, eq, inArray } from "drizzle-orm";
import { bankAnswer } from "./answer-schema.js";
import { type RequestError, type RequestResult, requestApproval } from "./approval-write.js";
import type { Db } from "./db.js";
import { readPackageInputs } from "./package-read.js";

// The Gate's entry point for an application package (NS-213 slice 1, APR-004, ADR-0002): it
// derives the package's policy facts from stored records instead of trusting its producer, so a
// confused producer can't make a package match one of Paul's auto-approve rules.

// A producer's claim that one filled field reuses a banked answer, with its own reading of how
// closely the form's question matched (the question canon lives in packages/profile).
export type BankClaim = {
  fieldName: string;
  answerId: string;
  version: number;
  variant: "long" | "short";
  source: "bank_exact" | "bank_high_confidence";
};

// The same slot syntax as adaptAnswer (packages/profile): only {company} may be filled. If the two
// ever drift, a claim fails to verify and counts as new, which only sends more to Paul.
const SLOT = /\{([^{}]*)\}/g;
const CHOICE_KINDS: ReadonlySet<string> = new Set(["select", "multi_select"]);
const words = (text: string) => text.split(/\s+/).filter((w) => w.length > 0).length;

// A banked template with its company slot filled, or null when it has another slot or no company.
function fill(template: string, company: string): string | null {
  for (const [, slot] of template.matchAll(SLOT)) {
    if (slot !== "company" || company === "") return null;
  }
  return template.replace(SLOT, () => company);
}

export async function requestPackageApproval(
  db: Db,
  input: {
    candidateId: CandidateId;
    package: unknown;
    claims: readonly BankClaim[];
    actor: string;
    idempotencyKey: string;
  },
): Promise<{ ok: true; value: RequestResult } | { ok: false; error: RequestError }> {
  const parsed = parsePackage(input.package);
  if (!parsed.ok) {
    return { ok: false, error: { kind: "InvalidRequest", fields: parsed.error.fields } };
  }
  const pkg = parsed.value;
  // The candidate's own application only: anything else names nothing the Gate can read.
  const inputs = await readPackageInputs(db, input.candidateId, pkg.applicationId);
  if (!inputs) {
    return { ok: false, error: { kind: "InvalidRequest", fields: ["package.applicationId"] } };
  }
  // Two claims for one field would leave which one counts to chance: refuse them.
  const claims = new Map<string, BankClaim>();
  for (const claim of input.claims) {
    if (claims.has(claim.fieldName)) {
      return { ok: false, error: { kind: "InvalidRequest", fields: ["claims"] } };
    }
    claims.set(claim.fieldName, claim);
  }

  // The stored form says which fields exist and which are choices; a form on another ATS isn't
  // this package's form.
  const form = inputs.form?.ats === pkg.ats ? inputs.form : null;
  const kinds = new Map(form?.questions.map((q) => [q.fieldName, q.kind]) ?? []);
  const ids = [...new Set([...claims.values()].map((c) => c.answerId))];
  const banked =
    ids.length === 0
      ? []
      : await db
          .select({
            id: bankAnswer.id,
            version: bankAnswer.version,
            shortText: bankAnswer.shortText,
            longText: bankAnswer.longText,
          })
          .from(bankAnswer)
          .where(and(eq(bankAnswer.candidateId, input.candidateId), inArray(bankAnswer.id, ids)));
  const company = inputs.companyName?.trim() ?? "";

  // A claim counts only when the field's value is exactly Paul's approved text for it.
  const verified = (
    fieldName: string,
    value: string | string[],
    claim: BankClaim | undefined,
  ): boolean => {
    // A banked answer is one text: a list of picked choices is never one.
    if (!claim || typeof value !== "string" || !kinds.has(fieldName)) return false;
    const row = banked.find((b) => b.id === claim.answerId && b.version === claim.version);
    const template = claim.variant === "long" ? row?.longText : row?.shortText;
    return typeof template === "string" && fill(template, company) === value;
  };

  const answers: PackageFacts["answers"] = [];
  // No cover-letter drafting exists yet, so any cover letter is new text Paul must review.
  if (pkg.coverLetter !== null) answers.push({ source: "new", freeTextWords: 0 });
  for (const [fieldName, value] of Object.entries(pkg.fields)) {
    const claim = claims.get(fieldName);
    answers.push({
      source: verified(fieldName, value, claim) && claim ? claim.source : "new",
      // A choice (or a list of picked choices) is no free text; any other field, or one the form
      // doesn't list, counts its words.
      freeTextWords:
        typeof value !== "string" || CHOICE_KINDS.has(kinds.get(fieldName) ?? "")
          ? 0
          : words(value),
    });
  }
  const facts: PackageFacts = {
    fit: inputs.fit,
    // Every ATS the package schema allows (APPLY_ATS) has a deterministic adapter (APPLY-002).
    adapter: "known",
    // Only stored shapes and the ledger count (APPLY-003), and only for this package's ATS.
    formSeenBefore: form !== null && inputs.formSeenBefore,
    answers,
  };
  return requestApproval(db, {
    candidateId: input.candidateId,
    kind: "application_package",
    subject: packageSubject(pkg),
    contentSha256: packageSha256(pkg),
    facts,
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
  });
}
