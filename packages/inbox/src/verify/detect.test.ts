import { describe, expect, it } from "vitest";
import { hasVerificationCode, isVerificationMail, VERIFICATION_PHRASES } from "./detect.js";

// Synthetic headers only (the repo is public). The ATS domains are the vendors' public sending
// domains, not anyone's personal data.
const h = (senderDomain: string, subject: string) => ({ senderDomain, subject });

describe("isVerificationMail", () => {
  it("is true for every verification phrase from an ATS sender, in any case", () => {
    for (const phrase of VERIFICATION_PHRASES) {
      expect(isVerificationMail(h("myworkday.com", `Acme: ${phrase}`))).toBe(true);
      expect(isVerificationMail(h("us.greenhouse-mail.io", phrase.toUpperCase()))).toBe(true);
    }
  });

  it("reads double and non-breaking spaces in the subject as one space", () => {
    expect(isVerificationMail(h("greenhouse-mail.io", "Security  code for Acme"))).toBe(true);
    expect(isVerificationMail(h("greenhouse-mail.io", "Your one-time\u00a0passcode"))).toBe(true);
  });

  it("is false for a confirmation from the same ATS sender", () => {
    expect(isVerificationMail(h("myworkday.com", "Thank you for applying to Acme"))).toBe(false);
  });

  it("is false for a verification subject from a sender that isn't an ATS", () => {
    expect(isVerificationMail(h("bank.example", "Your verification code"))).toBe(false);
  });

  it("is false for a look-alike of an ATS domain", () => {
    expect(isVerificationMail(h("notlever.co", "Verify your email"))).toBe(false);
    expect(isVerificationMail(h("lever.co.evil.example", "Verify your email"))).toBe(false);
  });

  it("is false when the sender domain is empty", () => {
    expect(isVerificationMail(h("", "Verify your email"))).toBe(false);
  });
});

describe("hasVerificationCode", () => {
  it("is true for an ATS body that gives a code", () => {
    expect(hasVerificationCode("myworkday.com", "Hi,\n\nYour code is 482913.\n")).toBe(true);
  });

  it("is false for an ATS body with a portal link and no code", () => {
    const body =
      "Thanks for applying. Track it at https://acme.wd5.myworkdayjobs.com/en-US/careers";
    expect(hasVerificationCode("myworkday.com", body)).toBe(false);
  });

  it("is false for a code from a sender that isn't an ATS", () => {
    expect(hasVerificationCode("bank.example", "Your code is 482913.")).toBe(false);
  });
});
