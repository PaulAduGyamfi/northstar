import { describe, expect, it } from "vitest";
import { classifyByRules } from "./classify-rules.js";
import { backfillQuery, isJobMail } from "./prefilter.js";

// Synthetic headers only (the repo is public). The domains are the real ATS vendors' sending
// domains, which are public facts, not anyone's personal data.
const h = (senderDomain: string, subject: string) => ({ senderDomain, subject });

describe("isJobMail", () => {
  it("keeps mail from a known ATS sending domain, including its subdomains", () => {
    expect(isJobMail(h("us.greenhouse-mail.io", "Hello"), new Set())).toBe(true);
    expect(isJobMail(h("hire.lever.co", "Update"), new Set())).toBe(true);
    expect(isJobMail(h("myworkday.com", "Update"), new Set())).toBe(true);
  });

  it("keeps mail whose subject is a job-mail phrase", () => {
    expect(isJobMail(h("globex.example.com", "Thank you for applying to Globex"), new Set())).toBe(
      true,
    );
    expect(
      isJobMail(h("globex.example.com", "Interview invitation: Backend Engineer"), new Set()),
    ).toBe(true);
    expect(isJobMail(h("globex.example.com", "Your application status"), new Set())).toBe(true);
  });

  it("keeps mail from a domain already on a funnel message", () => {
    expect(
      isJobMail(h("globex.example.com", "Quick question"), new Set(["globex.example.com"])),
    ).toBe(true);
  });

  it("drops newsletters and promotions, even ones that say offer or opportunity", () => {
    expect(isJobMail(h("shop.example.com", "Special offer: 20% off"), new Set())).toBe(false);
    expect(isJobMail(h("news.example.com", "A new opportunity to save"), new Set())).toBe(false);
    expect(isJobMail(h("friend.example.com", "Dinner on Friday?"), new Set())).toBe(false);
  });

  it("doesn't let a look-alike domain pass as an ATS", () => {
    expect(isJobMail(h("greenhouse.io.evil.example.com", "Hi"), new Set())).toBe(false);
    expect(isJobMail(h("notlever.co", "Hi"), new Set())).toBe(false);
  });
});

describe("backfillQuery", () => {
  it("starts at the given day and ORs the ATS senders and job phrases", () => {
    const q = backfillQuery("2026-02-01");
    expect(q.startsWith("after:2026/02/01 {")).toBe(true);
    expect(q).toContain("from:greenhouse-mail.io");
    expect(q).toContain('subject:"thank you for applying"');
  });
});

describe("classifyByRules", () => {
  it("reads company and role from a standard confirmation subject", () => {
    expect(
      classifyByRules({
        subject: "Thank you for applying for the Backend Engineer role at Globex",
      }),
    ).toEqual({ kind: "confirmation", company: "Globex", role: "Backend Engineer" });
  });

  it("reads the company when the subject names no role", () => {
    expect(classifyByRules({ subject: "Thanks for applying to Initech!" })).toEqual({
      kind: "confirmation",
      company: "Initech",
      role: null,
    });
    expect(classifyByRules({ subject: "Your application to Acme Corp has been received" })).toEqual(
      {
        kind: "confirmation",
        company: "Acme Corp",
        role: null,
      },
    );
  });

  it("leaves everything else to the model", () => {
    expect(classifyByRules({ subject: "We received your application" })).toBeNull();
    expect(classifyByRules({ subject: "Update on your application to Globex" })).toBeNull();
    expect(classifyByRules({ subject: "Interview invitation" })).toBeNull();
  });
});
