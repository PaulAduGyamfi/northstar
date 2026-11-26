import { APPLY_ATS } from "@northstar/domain";
import { describe, expect, it } from "vitest";
import { adapterFor, hostAllowed } from "./adapters/index.js";
import { mapPackage } from "./map.js";
import { CONFIRMATIONS, COVER, FORMS, makePackage, sha } from "./test/fixtures.js";

describe.each(APPLY_ATS)("the %s adapter", (ats) => {
  const adapter = adapterFor(ats);

  it("maps the package onto every required field of its form", () => {
    const result = mapPackage(adapter, FORMS[ats], makePackage(ats));
    expect(result.ok).toBe(true);
  });

  it("recognizes its confirmation page", () => {
    expect(adapter.isConfirmation(CONFIRMATIONS[ats])).toBe(true);
  });

  it("does not take the application form for a confirmation", () => {
    expect(adapter.isConfirmation({ url: makePackage(ats).applyUrl, html: "<form></form>" })).toBe(
      false,
    );
  });

  it("allows its own apply URL", () => {
    expect(hostAllowed(adapter, makePackage(ats).applyUrl)).toBe(true);
  });

  it("refuses an apply URL on another host", () => {
    expect(hostAllowed(adapter, "https://apply.example.com/jobs/4001")).toBe(false);
  });

  it("reads the posting id from its own apply URL", () => {
    const pkg = makePackage(ats);
    expect(adapter.postingIdOf(new URL(pkg.applyUrl).pathname)).toBe(pkg.postingId);
  });

  it("finds no posting id in a board's front page", () => {
    expect(adapter.postingIdOf("/examplecorp")).toBe(null);
  });

  it("names a required field the package leaves empty", () => {
    const required = FORMS[ats].find((f) => f.required && f.name in makePackage(ats).fields);
    if (!required) throw new Error("fixture has no required custom field");
    const fields = { ...makePackage(ats).fields };
    delete fields[required.name];
    expect(mapPackage(adapter, FORMS[ats], makePackage(ats, { fields }))).toEqual({
      ok: false,
      error: { kind: "unmapped_required", fields: [required.name] },
    });
  });

  it("calls the form changed when the package fills a field the form no longer has", () => {
    const fields = { ...makePackage(ats).fields, question_9999: "Yes" };
    expect(mapPackage(adapter, FORMS[ats], makePackage(ats, { fields }))).toEqual({
      ok: false,
      error: { kind: "form_changed", fields: ["question_9999"] },
    });
  });
});

describe("mapPackage", () => {
  const greenhouse = adapterFor("greenhouse");

  it("fills Greenhouse's standard fields from the contact block and plans the resume upload", () => {
    const result = mapPackage(greenhouse, FORMS.greenhouse, makePackage("greenhouse"));
    expect(result.ok && result.value).toEqual({
      fills: [
        { field: "first_name", value: "Ada" },
        { field: "last_name", value: "Example" },
        { field: "email", value: "ada@example.com" },
        { field: "question_1001", value: "Yes" },
        { field: "question_1002", value: "Synthetic answer for a test." },
      ],
      files: [{ field: "resume", kind: "resume" }],
    });
  });

  it("joins first and last name into Lever's one name field", () => {
    const result = mapPackage(adapterFor("lever"), FORMS.lever, makePackage("lever"));
    expect(result.ok && result.value.fills[0]).toEqual({ field: "name", value: "Ada Example" });
  });

  it("refuses a choice that is not one of the field's options", () => {
    const pkg = makePackage("greenhouse", {
      fields: { question_1001: "Maybe", question_1002: "x" },
    });
    expect(mapPackage(greenhouse, FORMS.greenhouse, pkg)).toEqual({
      ok: false,
      error: { kind: "form_changed", fields: ["question_1001"] },
    });
  });

  it("never lets the field map override a standard field", () => {
    const pkg = makePackage("greenhouse", {
      fields: { ...makePackage("greenhouse").fields, email: "other@example.com" },
    });
    expect(mapPackage(greenhouse, FORMS.greenhouse, pkg)).toEqual({
      ok: false,
      error: { kind: "form_changed", fields: ["email"] },
    });
  });

  it("plans a cover letter upload where the ATS takes one", () => {
    const pkg = makePackage("greenhouse", {
      coverLetter: { fileName: "cover.pdf", sha256: sha(COVER) },
    });
    const result = mapPackage(greenhouse, FORMS.greenhouse, pkg);
    expect(result.ok && result.value.files).toEqual([
      { field: "resume", kind: "resume" },
      { field: "cover_letter", kind: "coverLetter" },
    ]);
  });

  it("fills SmartRecruiters' standard fields and its phone only when given (NS-173)", () => {
    const sr = adapterFor("smartrecruiters");
    const pkg = makePackage("smartrecruiters", {
      contact: {
        firstName: "Ada",
        lastName: "Example",
        email: "ada@example.com",
        phone: "+1 555 0100",
      },
    });
    const result = mapPackage(sr, FORMS.smartrecruiters, pkg);
    expect(result.ok && result.value.fills).toEqual([
      { field: "firstName", value: "Ada" },
      { field: "lastName", value: "Example" },
      { field: "email", value: "ada@example.com" },
      { field: "phoneNumber", value: "+1 555 0100" },
      { field: "screening[q1]", value: "Yes" },
    ]);
  });

  it("reads a SmartRecruiters posting id with or without its title slug", () => {
    const sr = adapterFor("smartrecruiters");
    expect([
      sr.postingIdOf("/ExampleCorp/7440001234567"),
      sr.postingIdOf("/ExampleCorp/7440001234567-backend-engineer"),
      sr.postingIdOf("/ExampleCorp/backend-engineer"),
      sr.postingIdOf("/ExampleCorp/07440001234567"),
    ]).toEqual(["7440001234567", "7440001234567", null, null]);
  });

  it("doesn't take a SmartRecruiters job page whose description thanks applicants for a confirmation", () => {
    const sr = adapterFor("smartrecruiters");
    expect(
      sr.isConfirmation({
        url: "https://jobs.smartrecruiters.com/ExampleCorp/7440001234567-backend-engineer",
        html: "<html><body><p>About the role. Thank you for applying!</p><form></form></body></html>",
      }),
    ).toBe(false);
  });

  it("calls the form changed when a cover letter has nowhere to go", () => {
    const pkg = makePackage("lever", {
      coverLetter: { fileName: "cover.pdf", sha256: sha(COVER) },
    });
    expect(mapPackage(adapterFor("lever"), FORMS.lever, pkg)).toEqual({
      ok: false,
      error: { kind: "form_changed", fields: ["coverLetter"] },
    });
  });
});
