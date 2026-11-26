import { describe, expect, it } from "vitest";
import { MAIL_KINDS } from "../mail-schema.js";
import { LABEL_NAMES, threadLabels } from "./names.js";

describe("threadLabels", () => {
  it.each([
    ["confirmation", "Northstar/Confirmation"],
    ["rejection", "Northstar/Rejection"],
    ["assessment", "Northstar/Assessment"],
    ["interview_request", "Northstar/Interview"],
    ["scheduling", "Northstar/Interview"],
    ["recruiter_inbound", "Northstar/Recruiter"],
    ["follow_up_needed", "Northstar/Follow-up"],
    ["offer", "Northstar/Offer"],
  ] as const)("labels a %s thread %s", (kind, label) => {
    expect(threadLabels(kind, "unknown")).toEqual([label]);
  });

  it("gives other mail no type label", () => {
    expect(threadLabels("info_other", "unknown")).toEqual([]);
    expect(threadLabels(null, "unknown")).toEqual([]);
  });

  it("labels an application Northstar started, even one submitted by hand", () => {
    expect(threadLabels(null, "northstar")).toEqual(["Northstar/Started-by-Northstar"]);
    expect(threadLabels(null, "northstar_by_hand")).toEqual(["Northstar/Started-by-Northstar"]);
  });

  it("labels outside and recruiter-started applications Outside", () => {
    expect(threadLabels(null, "outside")).toEqual(["Northstar/Outside"]);
    expect(threadLabels(null, "recruiter_inbound")).toEqual(["Northstar/Outside"]);
  });

  it("gives both labels together", () => {
    expect(threadLabels("confirmation", "northstar")).toEqual([
      "Northstar/Confirmation",
      "Northstar/Started-by-Northstar",
    ]);
  });

  it("maps every mail kind, and every name sits under Northstar/", () => {
    for (const kind of MAIL_KINDS) expect(() => threadLabels(kind, "unknown")).not.toThrow();
    for (const name of LABEL_NAMES) expect(name).toMatch(/^Northstar\/[A-Za-z-]+$/);
    expect(LABEL_NAMES.size).toBe(9);
  });
});
