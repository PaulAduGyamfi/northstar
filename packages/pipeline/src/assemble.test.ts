import { packageSha256, parsePackage } from "@northstar/domain";
import { describe, expect, it } from "vitest";
import {
  type AssemblyInput,
  assemblePackage,
  type BankEntry,
  type FormQuestion,
} from "./assemble.js";

const sha = (c: string) => c.repeat(64);
const q = (fieldName: string, label: string, extra: Partial<FormQuestion> = {}): FormQuestion => ({
  fieldName,
  label,
  required: true,
  maxLength: null,
  choices: null,
  ...extra,
});
const bankEntry = (answerId: string, shortText: string): BankEntry => ({
  answerId,
  version: 2,
  shortText,
  longText: null,
});

// A synthetic job, contact and profile (example.com only).
const base = (over: Partial<AssemblyInput> = {}): AssemblyInput => ({
  packageId: "00000000-0000-4000-8000-0000000000a1",
  applicationId: "00000000-0000-4000-8000-0000000000b1",
  ats: "greenhouse",
  postingId: "4012345",
  applyUrl: "https://boards.greenhouse.io/example/jobs/4012345",
  company: "Example Co",
  contact: { firstName: "Test", lastName: "Person", email: "test@example.com", phone: null },
  resume: { fileName: "resume.pdf", sha256: sha("a") },
  coverLetter: null,
  coverLetterRequired: false,
  questions: [
    q("question_1", "Are you legally authorized to work in Canada?", { choices: ["Yes", "No"] }),
    q("question_2", "Why do you want to work at Example Co?"),
  ],
  settings: [{ field: "work_authorization", qualifier: "Canada", value: "yes" }],
  bank: new Map([["why-this-company", bankEntry("ans-1", "I like what {company} builds.")]]),
  fit: 82,
  formSeenBefore: true,
  ...over,
});

const SUBMARINE = "What is your favourite colour of submarine?";

describe("assemblePackage", () => {
  it("builds a valid package from settings and banked answers, with each answer's source", () => {
    const result = assemblePackage(base());
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const { package: pkg, sha256, sources } = result.value;
    expect(parsePackage(pkg).ok).toBe(true);
    expect(sha256).toBe(packageSha256(pkg));
    expect(pkg.fields).toEqual({
      question_1: "Yes",
      question_2: "I like what Example Co builds.",
    });
    expect(sources).toEqual([
      {
        fieldName: "question_1",
        from: "setting",
        field: "work_authorization",
        qualifier: "Canada",
      },
      expect.objectContaining({
        fieldName: "question_2",
        from: "bank",
        answerId: "ans-1",
        version: 2,
      }),
    ]);
  });

  it("reports facts for the Gate's policy, never counting a factual setting as reuse", () => {
    const result = assemblePackage(base());
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.facts).toMatchObject({ fit: 82, adapter: "known", formSeenBefore: true });
    expect(result.value.facts.answers[0]).toEqual({ source: "new", freeTextWords: 0 });
    expect(result.value.facts.answers[1]).toEqual({ source: "bank_exact", freeTextWords: 6 });
  });

  // The policy source of one banked answer, for a form label asking "why this company".
  const bankSourceFor = (label: string) => {
    const result = assemblePackage(base({ questions: [q("question_2", label)] }));
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value.facts.answers[0]?.source;
  };

  it("counts a banked answer as exact only for the canonical question's own wording", () => {
    expect(bankSourceFor("Why do you want to join Example Co?")).toBe("bank_exact");
  });

  it("counts a full match in other words as high confidence, not exact", () => {
    // Matches why-this-company at 1.0, but isn't one of its wordings.
    expect(bankSourceFor("Why are you interested in working at Example Co?")).toBe(
      "bank_high_confidence",
    );
  });

  it("counts a weak match as new, so Paul reviews it", () => {
    // Matches why-this-company at 0.75: above the matching floor, below high confidence.
    expect(bankSourceFor("What makes you want to work at Example Co?")).toBe("new");
  });

  it("never reuses a banked answer for a negated question", () => {
    const result = assemblePackage(
      base({ questions: [q("question_2", "Why would you NOT want to work at Example Co?")] }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { unanswered: [{ fieldName: "question_2", reason: "not_matched" }] },
    });
  });

  it("counts a cover letter as new text for Paul to review", () => {
    const result = assemblePackage(
      base({ questions: [], coverLetter: { fileName: "letter.pdf", sha256: sha("c") } }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.facts.answers).toEqual([{ source: "new", freeTextWords: 0 }]);
  });

  it("refuses a form with two questions under one field name", () => {
    const result = assemblePackage(
      base({
        questions: [
          q("question_1", "Are you legally authorized to work in Canada?"),
          q("question_1", "Why do you want to work at Example Co?"),
        ],
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "InvalidPackage", fields: ["question_1"] },
    });
  });

  it("needs Paul for every required question it can't answer, and says why", () => {
    const result = assemblePackage(
      base({
        settings: [],
        bank: new Map(),
        questions: [
          q("question_1", "Are you legally authorized to work in Canada?"),
          q("question_2", "Why do you want to work at Example Co?"),
          q("question_3", SUBMARINE),
        ],
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "NeedsHuman",
        unanswered: [
          { fieldName: "question_1", reason: "no_setting" },
          { fieldName: "question_2", reason: "no_bank_answer" },
          { fieldName: "question_3", reason: "not_matched" },
        ],
      },
    });
  });

  it("leaves an optional question it can't answer blank instead of guessing", () => {
    const result = assemblePackage(
      base({ questions: [q("question_9", SUBMARINE, { required: false })] }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.package.fields).toEqual({});
  });

  it("needs Paul when a banked answer is too long for the field", () => {
    const result = assemblePackage(
      base({
        questions: [q("question_2", "Why do you want to work at Example Co?", { maxLength: 10 })],
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { unanswered: [{ fieldName: "question_2", reason: "too_long" }] },
    });
  });

  it("needs Paul when the answer isn't one of the form's choices", () => {
    const result = assemblePackage(
      base({
        questions: [
          q("question_1", "Are you legally authorized to work in Canada?", {
            choices: ["Authorized", "Not authorized"],
          }),
        ],
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { unanswered: [{ fieldName: "question_1", reason: "not_a_choice" }] },
    });
  });

  it("needs Paul when the form requires a cover letter and none was given", () => {
    const result = assemblePackage(base({ coverLetterRequired: true }));
    expect(result).toMatchObject({
      ok: false,
      error: { unanswered: [{ fieldName: "cover_letter", reason: "cover_letter" }] },
    });
  });

  it("refuses a package that fails the schema, naming the fields", () => {
    const result = assemblePackage(base({ applyUrl: "http://boards.greenhouse.io/x" }));
    expect(result).toEqual({ ok: false, error: { kind: "InvalidPackage", fields: ["applyUrl"] } });
  });
});
