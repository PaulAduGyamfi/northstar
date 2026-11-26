import { describe, expect, it } from "vitest";
import { checkRecruiterFacts } from "./check.js";
import type { RecruiterFacts } from "./schema.js";

// A synthetic recruiter email (the repo is public).
const EMAIL = `Hi Paul,

I'm Dana from Initech. I saw your talk on payment retries and thought of you.
We're hiring a Senior Backend Engineer, fully remote, paying $150k - $180,000 a year.

Best,
Dana`;

const NONE: RecruiterFacts = {
  roleTitle: null,
  seniority: null,
  company: null,
  location: null,
  remote: null,
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: null,
  salaryPeriod: null,
  agency: null,
  personalizedQuote: null,
  redFlags: [],
};

const STATED: RecruiterFacts = {
  ...NONE,
  roleTitle: "Senior Backend Engineer",
  seniority: "Senior",
  company: "Initech",
  remote: "remote",
  salaryMin: 150_000,
  salaryMax: 180_000,
  salaryCurrency: "USD",
  salaryPeriod: "year",
  agency: false,
  personalizedQuote: "I saw your talk on payment retries",
};

describe("checkRecruiterFacts", () => {
  it("keeps every value the email states, including 150k as 150000", () => {
    expect(checkRecruiterFacts(STATED, EMAIL)).toEqual({ facts: STATED, dropped: [] });
  });

  it("drops an invented title, company and quote, naming each field", () => {
    const invented = {
      ...STATED,
      roleTitle: "Staff Engineer",
      company: "Globex",
      personalizedQuote: "I loved your open source work",
    };
    expect(checkRecruiterFacts(invented, EMAIL)).toEqual({
      facts: { ...STATED, roleTitle: null, company: null, personalizedQuote: null },
      dropped: ["roleTitle", "company", "personalizedQuote"],
    });
  });

  it("never keeps a salary number the email doesn't state", () => {
    expect(
      checkRecruiterFacts({ ...STATED, salaryMax: 250_000 }, EMAIL).facts.salaryMax,
    ).toBeNull();
  });

  it("drops the currency and period once no amount is left", () => {
    const facts = { ...STATED, salaryMin: 90_000, salaryMax: 95_000 };
    expect(checkRecruiterFacts(facts, EMAIL).dropped).toEqual([
      "salaryMin",
      "salaryMax",
      "salaryCurrency",
      "salaryPeriod",
    ]);
  });

  it("drops a way of working the email doesn't name", () => {
    expect(checkRecruiterFacts({ ...STATED, remote: "hybrid" }, EMAIL).dropped).toEqual(["remote"]);
  });

  it("matches whole words only, so a title inside a longer word doesn't count", () => {
    expect(checkRecruiterFacts({ ...STATED, seniority: "Seni" }, EMAIL).dropped).toEqual([
      "seniority",
    ]);
  });

  it("keeps a red flag only with a verbatim quote of four words or more", () => {
    const scam = `${EMAIL}\nPlease send a $200 equipment deposit before your first day.`;
    const facts: RecruiterFacts = {
      ...STATED,
      redFlags: [
        { kind: "upfront_fee", quote: "send a $200 equipment deposit" },
        { kind: "sensitive_data", quote: "send your passport" },
        { kind: "vague_role", quote: "Hi Paul" },
      ],
    };
    expect(checkRecruiterFacts(facts, scam)).toEqual({
      facts: {
        ...STATED,
        redFlags: [{ kind: "upfront_fee", quote: "send a $200 equipment deposit" }],
      },
      dropped: ["redFlags", "redFlags"],
    });
  });
});
