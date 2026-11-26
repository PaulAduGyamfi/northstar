import {
  type Db,
  listPendingApprovals,
  profileSchema,
  readPackageInputs,
  saveTailoredResume,
  schema,
  setApprovalPolicies,
  setContact,
  writeProfileImport,
} from "@northstar/db";
import { createTestDb, seedApplication } from "@northstar/db/testing";
import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Assembled, type AssemblyInput, assemblePackage } from "./assemble.js";
import { bankClaims, filePackage } from "./file.js";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let input: AssemblyInput;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "awaiting_approval");
  candidateId = CandidateId.parse(seeded.candidateId);
  const resumeSha = await storeJobInputs(seeded.jobId, seeded.applicationId);
  input = {
    packageId: "00000000-0000-4000-8000-0000000000a2",
    applicationId: seeded.applicationId,
    ats: "lever",
    postingId: "abc-123",
    applyUrl: "https://jobs.lever.co/example/abc-123/apply",
    company: "Example Co",
    contact: CONTACT,
    resume: { fileName: "resume.pdf", sha256: resumeSha },
    coverLetter: null,
    coverLetterRequired: false,
    questions: [],
    settings: [],
    bank: new Map(),
    fit: null,
    formSeenBefore: false,
  };
});
afterEach(() => close());

const CONTACT = { firstName: "Test", lastName: "Person", email: "test@example.com", phone: null };

// The Gate files a package only for the job's own posting, Paul's stored contact and his stored
// resume file (NS-213): store them, and give back the resume's SHA-256.
async function storeJobInputs(jobId: string, applicationId: string): Promise<string> {
  await db.insert(schema.jobSource).values({
    candidateId,
    jobId,
    url: "https://jobs.lever.co/example/abc-123",
    method: "ats_api",
    ats: "lever",
    atsPostingId: "abc-123",
  });
  await setContact(db, { candidateId, contact: CONTACT });
  await writeProfileImport(db, {
    candidateId,
    fileName: "resume.txt",
    textSha256: "e".repeat(64),
    promptVersion: 1,
    model: "claude-opus-5-5",
    traceId: null,
    call: {},
    extract: { roles: [], education: [], atoms: [], skills: [], certifications: [], links: [] },
  });
  const [source] = await db
    .select({ id: profileSchema.profileSource.id })
    .from(profileSchema.profileSource);
  await saveTailoredResume(db, {
    candidateId,
    jobId,
    profileSourceId: source?.id ?? "",
    resume: {},
    validation: {},
    score: {},
    droppedSkills: [],
    summary: {
      lines: 0,
      atoms: 0,
      addedSkills: 0,
      droppedSkills: 0,
      notClaimed: 0,
      keywordsCovered: 0,
      keywordsTotal: 0,
      titleMatch: "none",
      atsPass: true,
      valid: true,
      failures: 0,
    },
    pdf: new TextEncoder().encode("%PDF-1.7 synthetic"),
  });
  return (await readPackageInputs(db, candidateId, applicationId))?.resume?.pdfSha256 ?? "";
}

function assembled(): Assembled {
  const result = assemblePackage(input);
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

describe("filePackage", () => {
  it("puts an assembled package in Paul's queue as a pending request for that package", async () => {
    const filed = await filePackage(db, candidateId, assembled());
    if (!filed.ok) throw new Error(filed.error.kind);
    // No policy is set, so nothing auto-approves it: it waits for Paul.
    expect(filed.value.decision).toBeNull();
    const pending = await listPendingApprovals(db, candidateId, "application_package");
    expect(pending).toEqual([
      expect.objectContaining({
        requestId: filed.value.requestId,
        kind: "application_package",
        subject: `application_package:${input.packageId}`,
      }),
    ]);
  });

  it("lets the Gate read the facts: a producer's fit and seen form can't auto-approve a package", async () => {
    await setApprovalPolicies(db, {
      candidateId,
      rules: [
        {
          name: "any fit",
          kind: "application_package",
          minFit: 0,
          allowHighConfidenceAnswers: true,
          maxFreeTextWords: 1000,
        },
      ],
    });
    // The producer says fit 95 and a seen form; nothing stored says either.
    input = { ...input, fit: 95, formSeenBefore: true };
    const filed = await filePackage(db, candidateId, assembled());
    if (!filed.ok) throw new Error(filed.error.kind);
    expect([filed.value.decision, filed.value.outcome]).toEqual([
      null,
      { auto: false, why: [{ rule: "any fit", failed: ["fit", "form_seen_before"] }] },
    ]);
  });

  it("replays instead of filing the same package twice", async () => {
    const pkg = assembled();
    const first = await filePackage(db, candidateId, pkg);
    const second = await filePackage(db, candidateId, pkg);
    if (!first.ok || !second.ok) throw new Error("filing failed");
    expect(second.value).toMatchObject({ requestId: first.value.requestId, replayed: true });
    expect(await listPendingApprovals(db, candidateId, "application_package")).toHaveLength(1);
  });
});

describe("bankClaims", () => {
  const ANSWER = "00000000-0000-4000-8000-0000000000b1";
  const bank = (over: object) => ({
    fieldName: "question_1",
    from: "bank" as const,
    answerId: ANSWER,
    version: 2,
    variant: "short" as const,
    confidence: 0.5,
    exactWording: false,
    confirmedBy: "rules" as const,
    ...over,
  });

  it("claims exactly the bank answers assemblePackage counts as reuse, with their version and variant", () => {
    const sources: Assembled["sources"] = [
      bank({ fieldName: "exact", exactWording: true, variant: "long" }),
      bank({ fieldName: "high", confidence: 0.9 }),
      bank({ fieldName: "low", confidence: 0.5 }),
      bank({ fieldName: "model", exactWording: true, confirmedBy: "model" }),
      { fieldName: "setting", from: "setting", field: "needs_sponsorship", qualifier: "" },
    ];
    expect(bankClaims({ ...assembled(), sources })).toEqual([
      { fieldName: "exact", answerId: ANSWER, version: 2, variant: "long", source: "bank_exact" },
      {
        fieldName: "high",
        answerId: ANSWER,
        version: 2,
        variant: "short",
        source: "bank_high_confidence",
      },
    ]);
  });
});
