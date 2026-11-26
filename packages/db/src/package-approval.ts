import {
  type CandidateId,
  isSafeCompany,
  type PackageFacts,
  packageSha256,
  packageSubject,
  parsePackage,
} from "@northstar/domain";
import { type RequestError, type RequestResult, requestApproval } from "./approval-write.js";
import type { Db } from "./db.js";
import { readPackageInputs } from "./package-read.js";

// The Gate's entry point for an application package (NS-213 slice 1, APR-004, ADR-0002): it
// derives the package's policy facts from stored records instead of trusting its producer, so a
// confused producer can't make a package match one of Paul's auto-approve rules.

// A producer's claim that one filled field reuses a banked answer, with its own reading of how
// closely the form's question matched (the question canon lives in packages/profile). Which
// question the answer belongs to is the producer's too: the Gate checks the text, not the match.
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
// Fields a banked answer can fill: no hidden or upload field, as formQuestions (packages/pipeline).
const ANSWERABLE_KINDS: ReadonlySet<string> = new Set([
  "text",
  "textarea",
  "select",
  "multi_select",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const words = (text: string) => text.split(/\s+/).filter((w) => w.length > 0).length;

// A banked template with its company slot filled, or null when it has another slot, or the
// company is missing or not a plain short name (job data is untrusted: isSafeCompany).
function fill(template: string, company: string): string | null {
  for (const [, slot] of template.matchAll(SLOT)) {
    if (slot !== "company" || company === "" || !isSafeCompany(company)) return null;
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
  // The package must be for this application's own job, contact details and resume file: fit and
  // form-seen-before are read for that job, and an auto-approved package goes out unseen.
  const mismatched = [
    // The posting is one of the job's stored sources, compared as the Apply Gateway does.
    inputs.sources.some(
      (s) => s.ats === pkg.ats && s.postingId?.toLowerCase() === pkg.postingId.toLowerCase(),
    )
      ? null
      : "package.postingId",
    sameContact(inputs.contact, pkg.contact) ? null : "package.contact",
    inputs.resume?.pdfSha256 === pkg.resume.sha256 ? null : "package.resume",
  ].filter((f): f is string => f !== null);
  if (mismatched.length > 0) {
    return { ok: false, error: { kind: "InvalidRequest", fields: mismatched } };
  }
  // Two claims for one field would leave which one counts to chance: refuse them, and any claim
  // not shaped as one (the Gate checks its input, never the database's error).
  const claims = new Map<string, BankClaim>();
  for (const claim of input.claims) {
    if (claims.has(claim.fieldName) || !wellFormed(claim)) {
      return { ok: false, error: { kind: "InvalidRequest", fields: ["claims"] } };
    }
    claims.set(claim.fieldName, claim);
  }

  // The stored form says which fields exist and which are choices; a form on another ATS isn't
  // this package's form.
  const form = inputs.form?.ats === pkg.ats ? inputs.form : null;
  const kinds = new Map(form?.questions.map((q) => [q.fieldName, q.kind]) ?? []);
  const company = inputs.companyName?.trim() ?? "";

  // A claim counts only when the field's value is exactly Paul's approved text for it, in the
  // newest version of that answer (inputs.bank holds only the newest per canonical question).
  const verified = (fieldName: string, value: string | string[], claim: BankClaim): boolean => {
    // A banked answer is one text: a list of picked choices is never one.
    if (typeof value !== "string" || !ANSWERABLE_KINDS.has(kinds.get(fieldName) ?? ""))
      return false;
    const row = inputs.bank.find(
      (b) => b.answerId === claim.answerId && b.version === claim.version,
    );
    const template = claim.variant === "long" ? row?.longText : row?.shortText;
    return typeof template === "string" && fill(template, company) === value;
  };

  const answers: PackageFacts["answers"] = [];
  // No cover-letter drafting exists yet, so any cover letter is new text Paul must review.
  if (pkg.coverLetter !== null) answers.push({ source: "new", freeTextWords: 0 });
  for (const [fieldName, value] of Object.entries(pkg.fields)) {
    const claim = claims.get(fieldName);
    answers.push({
      source: claim && verified(fieldName, value, claim) ? claim.source : "new",
      // A choice (or a list of picked choices) is no free text; any other field, or one the form
      // doesn't list, counts its words. A factual setting's value counts too: it is `new` anyway,
      // so it never auto-approves either way.
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
  // These reads run before requestApproval's own transaction: a fit or form stored in between
  // only shows on the next package, and the request still pins this package's content.
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

function sameContact(
  stored: { firstName: string; lastName: string; email: string; phone: string | null } | null,
  given: { firstName: string; lastName: string; email: string; phone: string | null },
): boolean {
  return (
    stored !== null &&
    stored.firstName === given.firstName &&
    stored.lastName === given.lastName &&
    stored.email === given.email &&
    stored.phone === given.phone
  );
}

function wellFormed(claim: BankClaim): boolean {
  return (
    typeof claim.fieldName === "string" &&
    claim.fieldName.length > 0 &&
    UUID.test(claim.answerId) &&
    Number.isInteger(claim.version) &&
    claim.version >= 1 &&
    (claim.variant === "long" || claim.variant === "short") &&
    (claim.source === "bank_exact" || claim.source === "bank_high_confidence")
  );
}
