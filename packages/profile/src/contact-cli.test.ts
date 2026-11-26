import type { ContactRefusal } from "@northstar/db";
import type { ContactDetails } from "@northstar/domain";
import { describe, expect, it } from "vitest";
import { CONTACT_USAGE, type ContactCliDeps, contactCommand } from "./contact-cli.js";

// `profile contact set|show` (NS-227 slice 3) with the store faked. Synthetic details only.

function deps(over: Partial<ContactCliDeps> = {}) {
  const printed: string[] = [];
  const saved: ContactDetails[] = [];
  const d: ContactCliDeps = {
    print: (line) => printed.push(line),
    setContact: async (contact) => {
      saved.push(contact);
      return { ok: true, value: { saved: true } };
    },
    readContact: async () => null,
    ...over,
  };
  return { d, printed, saved };
}

const SET = ["set", "--first", "Test", "--last", "Person", "--email", "test@example.com"];

describe("profile contact", () => {
  it("saves the details with no phone when --phone is left out", async () => {
    const { d, printed, saved } = deps();
    expect([await contactCommand(d, SET), saved, printed]).toEqual([
      0,
      [{ firstName: "Test", lastName: "Person", email: "test@example.com", phone: null }],
      ["Saved your contact details."],
    ]);
  });

  it("takes the flags in any order, with a phone", async () => {
    const { d, saved } = deps();
    await contactCommand(d, [
      "set",
      "--phone",
      "+1 555 0100",
      "--email",
      "test@example.com",
      "--last",
      "Person",
      "--first",
      "Test",
    ]);
    expect(saved[0]?.phone).toBe("+1 555 0100");
  });

  it("says when the details are unchanged", async () => {
    const { d, printed } = deps({
      setContact: async () => ({ ok: true, value: { saved: false } }),
    });
    await contactCommand(d, SET);
    expect(printed).toEqual(["Your contact details already say that."]);
  });

  it("says which fields were refused, in words", async () => {
    const error: ContactRefusal = { kind: "InvalidContact", fields: ["email", "phone"] };
    const { d, printed } = deps({ setContact: async () => ({ ok: false, error }) });
    expect([await contactCommand(d, SET), printed]).toEqual([
      1,
      [
        "Not saved: --email takes one email address of at most 254 characters; --phone takes 1 to 40 characters on one line.",
      ],
    ]);
  });

  it("prints the current details, or how to set them", async () => {
    const none = deps();
    const some = deps({
      readContact: async () => ({
        firstName: "Test",
        lastName: "Person",
        email: "test@example.com",
        phone: null,
      }),
    });
    await contactCommand(none.d, ["show"]);
    await contactCommand(some.d, ["show"]);
    expect([none.printed, some.printed]).toEqual([
      ["No contact details yet. Run: profile contact set --first … --last … --email …"],
      ["Name: Test Person", "Email: test@example.com", "Phone: none"],
    ]);
  });

  it("prints its usage and saves nothing for a missing, repeated or unknown flag", async () => {
    const { d, printed, saved } = deps();
    const bad = [
      ["set", "--first", "Test", "--last", "Person"],
      [...SET, "--first", "Again"],
      [...SET, "--fax", "1"],
      [...SET, "--phone"],
      ["show", "extra"],
      [],
    ];
    const codes = [];
    for (const args of bad) codes.push(await contactCommand(d, args));
    expect([codes, saved, printed]).toEqual([[1, 1, 1, 1, 1, 1], [], Array(6).fill(CONTACT_USAGE)]);
  });
});
