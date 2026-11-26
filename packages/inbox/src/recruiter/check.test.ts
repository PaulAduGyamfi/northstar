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

  it("doesn't count a number as pay unless it's written with the currency", () => {
    const team = "Hi Paul, Initech is 200 engineers. Pay in $ to be discussed, 180000 per year.";
    const facts = { ...STATED, salaryMin: 200, salaryMax: 180_000 };
    expect(checkRecruiterFacts(facts, team).dropped).toEqual(
      expect.arrayContaining(["salaryMin", "salaryMax"]),
    );
  });

  it("drops a currency the email only spells inside another word", () => {
    const decade = "Hi Paul, a decade-old Initech team pays $150k a year.";
    const facts = { ...STATED, salaryMin: 150_000, salaryMax: 150_000, salaryCurrency: "CAD" };
    expect(
      checkRecruiterFacts(facts, decade).dropped.filter((f) => f.startsWith("salary")),
    ).toEqual(["salaryMin", "salaryMax", "salaryCurrency", "salaryPeriod"]);
  });

  it("drops a pay period the email doesn't state", () => {
    expect(checkRecruiterFacts({ ...STATED, salaryPeriod: "hour" }, EMAIL).dropped).toEqual([
      "salaryPeriod",
    ]);
  });

  it("reads a shared k, decimals and a coded range as the amounts they write", () => {
    const shapes = "Pay: $150-180k a year, or 142.3k - 150,500 USD a year.";
    const keep = (min: number, max: number, currency: string) =>
      checkRecruiterFacts(
        { ...STATED, salaryMin: min, salaryMax: max, salaryCurrency: currency },
        shapes,
      ).dropped.filter((f) => f.startsWith("salary"));
    expect([keep(150_000, 180_000, "USD"), keep(142_300, 150_500, "USD")]).toEqual([[], []]);
  });

  it("doesn't read a number inside a word as pay", () => {
    const km = "Hi Paul, the office is 150km away and pays $90k a year.";
    expect(checkRecruiterFacts({ ...STATED, salaryMin: 150_000 }, km).dropped).toContain(
      "salaryMin",
    );
  });

  it("keeps on site and remotely as the email writes them", () => {
    const onSite = "Hi Paul, the role at Initech is on site in Chicago.";
    const remotely = "Hi Paul, you would work remotely for Initech.";
    expect([
      checkRecruiterFacts({ ...STATED, remote: "onsite" }, onSite).facts.remote,
      checkRecruiterFacts({ ...STATED, remote: "remote" }, remotely).facts.remote,
    ]).toEqual(["onsite", "remote"]);
  });

  it("drops remote when the email also names working on site", () => {
    const both = "Senior Backend Engineer at Initech. Not remote: onsite in Chicago.";
    expect(checkRecruiterFacts(STATED, both).facts.remote).toBeNull();
  });

  it("adds the red flags plain code finds, even when the model reports none", () => {
    const scam =
      "Welcome aboard! Please send a $300 equipment deposit by gift card, and reply with your bank account number.";
    expect(
      checkRecruiterFacts({ ...STATED, redFlags: [] }, scam).facts.redFlags.map((f) => f.kind),
    ).toEqual(["upfront_fee", "sensitive_data"]);
  });
});
