import { describe, expect, it } from "vitest";
import {
  type ApplicationPackage,
  packageSha256,
  packageSubject,
  parsePackage,
} from "./apply-package.js";

const pkg: ApplicationPackage = {
  packageId: "11111111-1111-4111-8111-111111111111",
  applicationId: "22222222-2222-4222-8222-222222222222",
  ats: "greenhouse",
  postingId: "4001",
  applyUrl: "https://boards.greenhouse.io/examplecorp/jobs/4001",
  contact: { firstName: "Ada", lastName: "Example", email: "ada@example.com", phone: null },
  resume: { fileName: "resume.pdf", sha256: "a".repeat(64) },
  coverLetter: null,
  fields: { question_1: "Yes", question_2: ["Remote"] },
};

describe("parsePackage", () => {
  it("accepts a complete package", () => {
    expect(parsePackage(pkg)).toEqual({ ok: true, value: pkg });
  });

  it("refuses a plain-http apply URL and names the field", () => {
    expect(parsePackage({ ...pkg, applyUrl: "http://boards.greenhouse.io/x" })).toEqual({
      ok: false,
      error: { kind: "InvalidPackage", fields: ["applyUrl"] },
    });
  });

  it("refuses an ATS without an adapter", () => {
    expect(parsePackage({ ...pkg, ats: "workday" })).toEqual({
      ok: false,
      error: { kind: "InvalidPackage", fields: ["ats"] },
    });
  });
});

describe("packageSha256", () => {
  it("is the same whatever order the keys were written in", () => {
    const reordered = {
      fields: { question_2: ["Remote"], question_1: "Yes" },
      coverLetter: null,
      resume: { sha256: "a".repeat(64), fileName: "resume.pdf" },
      contact: { phone: null, email: "ada@example.com", lastName: "Example", firstName: "Ada" },
      applyUrl: pkg.applyUrl,
      postingId: "4001",
      ats: "greenhouse" as const,
      applicationId: pkg.applicationId,
      packageId: pkg.packageId,
    };
    expect(packageSha256(reordered)).toBe(packageSha256(pkg));
  });

  it("changes when any answer changes", () => {
    const edited = { ...pkg, fields: { ...pkg.fields, question_1: "No" } };
    expect(packageSha256(edited)).not.toBe(packageSha256(pkg));
  });

  it("is 64 hex characters", () => {
    expect(packageSha256(pkg)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("packageSubject", () => {
  it("names the package, not the job", () => {
    expect(packageSubject(pkg)).toBe("application_package:11111111-1111-4111-8111-111111111111");
  });
});
