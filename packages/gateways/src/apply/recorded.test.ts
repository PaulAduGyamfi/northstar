import { describe, expect, it } from "vitest";
import { adapterFor } from "./adapters/index.js";
import { challengeOf, collectPage, pickForm } from "./browser/collect.js";
import { controlKey, RECORDED, recordedPage } from "./test/recorded.js";

// The adapters against RECORDED form structures (NS-142 slice 2, #76): the field names they fill
// must be fields the real forms have. Offline: the recordings are committed data. What the
// recordings showed the driver can't do yet is #353 (NS-255); those tests are there, not here.

const CONTACT = {
  firstName: "Ada",
  lastName: "Example",
  email: "ada@example.com",
  phone: "+1 555 0100",
};

describe("each adapter's fields are on its recorded form", () => {
  it.each(["greenhouse", "lever"] as const)(
    "every standard, resume and cover-letter field %s fills is a control on the recorded form",
    (ats) => {
      const a = adapterFor(ats);
      const keys = new Set(
        RECORDED[ats].controls.filter((c) => c.tag !== "button").map(controlKey),
      );
      const wanted = [
        ...Object.keys(a.standardFields(CONTACT)),
        a.resumeField,
        ...(a.coverLetterField === null ? [] : [a.coverLetterField]),
      ];
      expect(wanted.filter((k) => !keys.has(k))).toEqual([]);
    },
  );

  // The adapter's names are there as ids only. The driver reads and fills by name, so on the real
  // board it finds no form at all and refuses: a known gap, and the safe outcome, until #353.
  it("reads no fields from the recorded Greenhouse form, because it names none of its controls", () => {
    const named = RECORDED.greenhouse.controls.filter((c) => c.name !== undefined);
    const picked = pickForm(collectPage(null, recordedPage(RECORDED.greenhouse)).forms);
    expect([named, picked]).toEqual([[], null]);
  });
});

describe("the driver's in-page reader on a recorded Lever form", () => {
  it("reads the contact and resume fields the Lever adapter fills, as the page has them", () => {
    const picked = pickForm(collectPage(null, recordedPage(RECORDED.lever)).forms);
    const standard = picked?.fields.filter((f) =>
      ["name", "email", "phone", "resume"].includes(f.name),
    );
    expect(standard).toEqual([
      { name: "resume", type: "file", required: false },
      { name: "name", type: "text", required: true },
      { name: "email", type: "email", required: true },
      { name: "phone", type: "text", required: false },
    ]);
  });

  it("treats Lever's script-sized hCaptcha as a CAPTCHA, so Lever applications go to Paul's hands until #353 decides", () => {
    const { signals } = collectPage(null, recordedPage(RECORDED.lever));
    expect([signals.visibleCaptcha, challengeOf(signals)]).toEqual([true, "captcha"]);
  });
});

describe("the driver's in-page reader on the recorded SmartRecruiters posting page (slice 3)", () => {
  // The apply step answered with a bot check, so only the posting page could be recorded. It has
  // no form, so the driver opens no form there and the gateway hands the application to Paul.
  it("finds no form on the posting page, so a SmartRecruiters application becomes a handoff", () => {
    const page = collectPage(null, recordedPage(RECORDED.smartrecruiters));
    expect([page.forms, pickForm(page.forms)]).toEqual([[], null]);
  });
});
