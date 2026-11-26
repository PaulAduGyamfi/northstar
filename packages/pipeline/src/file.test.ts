import { type Db, listPendingApprovals, setApprovalPolicies } from "@northstar/db";
import { createTestDb, seedApplication } from "@northstar/db/testing";
import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Assembled, type AssemblyInput, assemblePackage } from "./assemble.js";
import { filePackage } from "./file.js";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let input: AssemblyInput;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "awaiting_approval");
  candidateId = CandidateId.parse(seeded.candidateId);
  input = {
    packageId: "00000000-0000-4000-8000-0000000000a2",
    applicationId: seeded.applicationId,
    ats: "lever",
    postingId: "abc-123",
    applyUrl: "https://jobs.lever.co/example/abc-123/apply",
    company: "Example Co",
    contact: { firstName: "Test", lastName: "Person", email: "test@example.com", phone: null },
    resume: { fileName: "resume.pdf", sha256: "b".repeat(64) },
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
