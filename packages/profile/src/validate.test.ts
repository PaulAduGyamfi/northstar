import { describe, expect, it } from "vitest";
import { SAMPLE_RESUME, sampleExtract } from "./test/sample.js";
import { validateProvenance } from "./validate.js";

describe("validateProvenance", () => {
  it("passes a faithful extraction", () => {
    expect(validateProvenance(sampleExtract(), SAMPLE_RESUME)).toEqual({ ok: true });
  });

  it("accepts a quote that the resume wraps across two lines", () => {
    // sampleExtract's second atom is the wrapped bullet.
    expect(validateProvenance(sampleExtract(), SAMPLE_RESUME).ok).toBe(true);
  });

  it("accepts curly quotes and dashes that differ only in typography", () => {
    const text = SAMPLE_RESUME.replace(
      "Wrote the on-call runbook.",
      "Wrote the “on‑call” runbook.",
    );
    const x = sampleExtract();
    x.atoms.push({
      ...x.atoms[0],
      what: "Wrote the runbook",
      how: [],
      impact: null,
      sourceQuote: 'Wrote the "on-call" runbook.',
    } as (typeof x.atoms)[number]);
    expect(validateProvenance(x, text)).toEqual({ ok: true });
  });

  it("rejects an atom whose quote isn't in the resume", () => {
    const x = sampleExtract();
    const atom = x.atoms[2];
    if (atom) atom.sourceQuote = "Built a route planner in Rust that cut planning time by 35%.";
    expect(validateProvenance(x, SAMPLE_RESUME)).toEqual({
      ok: false,
      failures: [{ item: "atom", index: 2, problem: "quote_not_in_resume" }],
    });
  });

  it("rejects an impact with a number its quote doesn't contain", () => {
    const x = sampleExtract();
    const atom = x.atoms[0];
    if (atom) atom.impact = "cut duplicate charges by 40%";
    expect(validateProvenance(x, SAMPLE_RESUME)).toEqual({
      ok: false,
      failures: [{ item: "atom", index: 0, problem: "number_not_in_quote" }],
    });
  });

  it("rejects a scope with a number its quote doesn't contain", () => {
    const x = sampleExtract();
    const atom = x.atoms[1];
    if (atom) atom.scope = "team of 12 engineers";
    expect(validateProvenance(x, SAMPLE_RESUME)).toEqual({
      ok: false,
      failures: [{ item: "atom", index: 1, problem: "number_not_in_quote" }],
    });
  });

  it("rejects an employer or title that isn't written in the resume", () => {
    const x = sampleExtract();
    const role = x.roles[0];
    if (role) role.employer = "Example Payments Inc.";
    const second = x.roles[1];
    if (second) second.title = "Senior Software Engineer II";
    expect(validateProvenance(x, SAMPLE_RESUME)).toEqual({
      ok: false,
      failures: [
        { item: "role", index: 0, problem: "employer_not_in_resume" },
        { item: "role", index: 1, problem: "title_not_in_resume" },
      ],
    });
  });

  it("rejects a school, degree, skill, certification or link that isn't in the resume", () => {
    const x = sampleExtract();
    const edu = x.education[0];
    if (edu) edu.degree = "MSc";
    x.skills.push("Rust");
    const cert = x.certifications[0];
    if (cert) cert.name = "Example Cloud Professional";
    x.links.push({ label: "Blog", url: "https://blog.example.com" });
    expect(validateProvenance(x, SAMPLE_RESUME)).toEqual({
      ok: false,
      failures: [
        { item: "education", index: 0, problem: "degree_not_in_resume" },
        { item: "skill", index: 4, problem: "not_in_resume" },
        { item: "certification", index: 0, problem: "not_in_resume" },
        { item: "link", index: 2, problem: "not_in_resume" },
      ],
    });
  });

  it("rejects a role date the resume doesn't state (dates are locked facts)", () => {
    const x = sampleExtract();
    const role = x.roles[0];
    if (role) role.startMonth = "2020-03";
    expect(validateProvenance(x, SAMPLE_RESUME)).toEqual({
      ok: false,
      failures: [{ item: "role", index: 0, problem: "date_not_in_resume" }],
    });
  });

  it("accepts a month written as a number next to its year", () => {
    const text = SAMPLE_RESUME.replace("March 2021", "03/2021");
    expect(validateProvenance(sampleExtract(), text)).toEqual({ ok: true });
  });

  it("matches names as whole words, so an invented skill can't hide inside a longer word", () => {
    const text = SAMPLE_RESUME.replace(
      "Go, Postgres, Python, Kafka",
      "Postgres, Python, Kafka, Google Cloud",
    ).replace("in Go and Postgres", "in Golang and Postgres");
    const x = sampleExtract();
    const atom = x.atoms[0];
    if (atom) {
      atom.sourceQuote =
        "Made payment retries idempotent in Golang and Postgres, cutting duplicate charges to zero.";
      atom.how = ["Golang", "Postgres"];
    }
    // "Go" appears only inside "Google" and "Golang" now.
    expect(validateProvenance(x, text)).toEqual({
      ok: false,
      failures: [{ item: "skill", index: 0, problem: "not_in_resume" }],
    });
  });

  it("rejects an atom whose headline claims a number its quote doesn't", () => {
    const x = sampleExtract();
    const atom = x.atoms[0];
    if (atom) atom.what = "Made 12 payment services idempotent";
    expect(validateProvenance(x, SAMPLE_RESUME)).toEqual({
      ok: false,
      failures: [{ item: "atom", index: 0, problem: "number_not_in_quote" }],
    });
  });

  it("rejects a stack item the bullet never names", () => {
    const x = sampleExtract();
    const atom = x.atoms[0];
    if (atom) atom.how = ["Go", "Kubernetes"];
    expect(validateProvenance(x, SAMPLE_RESUME)).toEqual({
      ok: false,
      failures: [{ item: "atom", index: 0, problem: "how_not_in_quote" }],
    });
  });

  it("rejects an atom month its own bullet doesn't state", () => {
    const x = sampleExtract();
    const atom = x.atoms[0];
    // March 2021 is in the resume, but not in this bullet.
    if (atom) atom.startMonth = "2021-03";
    expect(validateProvenance(x, SAMPLE_RESUME)).toEqual({
      ok: false,
      failures: [{ item: "atom", index: 0, problem: "date_not_in_quote" }],
    });
  });

  it("rejects duplicate role keys and atoms pointing at a role that doesn't exist", () => {
    const x = sampleExtract();
    const second = x.roles[1];
    if (second) second.key = "r1";
    const atom = x.atoms[2];
    if (atom) atom.roleKey = "r9";
    expect(validateProvenance(x, SAMPLE_RESUME)).toEqual({
      ok: false,
      failures: [
        { item: "role", index: 1, problem: "duplicate_role_key" },
        { item: "atom", index: 2, problem: "unknown_role_key" },
      ],
    });
  });

  it("doesn't take C# or C++ as the skill C", () => {
    const text = SAMPLE_RESUME.replace(
      "Go, Postgres, Python, Kafka",
      "Go, Postgres, Python, Kafka, C#",
    );
    const x = sampleExtract();
    x.skills.push("C");
    expect(validateProvenance(x, text)).toEqual({
      ok: false,
      failures: [{ item: "skill", index: 4, problem: "not_in_resume" }],
    });
  });

  it("accepts a year-only date as a year, and rejects one the resume doesn't state", () => {
    const text = SAMPLE_RESUME.replace("June 2017 – February 2021", "2017 – 2021");
    const x = sampleExtract();
    const role = x.roles[1];
    if (role) {
      role.startMonth = "2017";
      role.endMonth = "2021";
    }
    expect(validateProvenance(x, text)).toEqual({ ok: true });
    if (role) role.startMonth = "2016";
    expect(validateProvenance(x, text)).toEqual({
      ok: false,
      failures: [{ item: "role", index: 1, problem: "date_not_in_resume" }],
    });
  });

  it("rejects a role's dates that belong to another role (dates must sit next to their role)", () => {
    const x = sampleExtract();
    const first = x.roles[0];
    const second = x.roles[1];
    if (first && second) {
      // Swap the start months: each month is in the resume, but next to the other role.
      [first.startMonth, second.startMonth] = [second.startMonth, first.startMonth];
    }
    expect(validateProvenance(x, SAMPLE_RESUME)).toEqual({
      ok: false,
      failures: [
        { item: "role", index: 0, problem: "date_not_in_resume" },
        { item: "role", index: 1, problem: "date_not_in_resume" },
      ],
    });
  });

  it("accepts a current role only when the resume says so next to that role", () => {
    const x = sampleExtract();
    const past = x.roles[1];
    if (past) {
      past.current = true;
      past.endMonth = null;
    }
    expect(validateProvenance(x, SAMPLE_RESUME)).toEqual({
      ok: false,
      failures: [{ item: "role", index: 1, problem: "current_not_in_resume" }],
    });
  });

  it("doesn't take \"now\" in a bullet's prose as the role being current", () => {
    // "Present" counts only after a dash or "to" ("2021 – Present", "2021 to now").
    const text = SAMPLE_RESUME.replace(
      "cut planning time by 35%.\n",
      "cut planning time by 35%.\n• Every team now uses the planner.\n",
    );
    const x = sampleExtract();
    const past = x.roles[1];
    if (past) {
      past.current = true;
      past.endMonth = null;
    }
    expect(validateProvenance(x, text)).toEqual({
      ok: false,
      failures: [{ item: "role", index: 1, problem: "current_not_in_resume" }],
    });
  });

  it("rejects an education date written next to something else, not the school", () => {
    const x = sampleExtract();
    const edu = x.education[0];
    // January 2023 is in the resume, but on the certification line.
    if (edu) edu.endMonth = "2023-01";
    expect(validateProvenance(x, SAMPLE_RESUME)).toEqual({
      ok: false,
      failures: [{ item: "education", index: 0, problem: "date_not_in_resume" }],
    });
  });

  it("rejects a certification date written next to something else, not the certification", () => {
    const x = sampleExtract();
    const cert = x.certifications[0];
    // March 2021 is in the resume, but on the first role's line.
    if (cert) cert.issuedMonth = "2021-03";
    expect(validateProvenance(x, SAMPLE_RESUME)).toEqual({
      ok: false,
      failures: [{ item: "certification", index: 0, problem: "date_not_in_resume" }],
    });
  });

  it("known limit (ADR-0004): in a compact layout a role can borrow the line above's Present", () => {
    // Two one-line roles: Beta's 120-character window reaches Acme's "– Present". This test pins
    // the limit so a change to it is deliberate; Paul's read-back (profile show) covers it.
    const text = "Engineer, Acme Example · 2021 – Present\nEngineer, Beta Example · 2019 – 2021\n";
    const x = {
      ...sampleExtract(),
      roles: [
        {
          key: "a",
          employer: "Acme Example",
          title: "Engineer",
          startMonth: "2021",
          endMonth: null,
          current: true,
        },
        {
          key: "b",
          employer: "Beta Example",
          title: "Engineer",
          startMonth: "2019",
          endMonth: null,
          current: true,
        },
      ],
      education: [],
      atoms: [],
      skills: [],
      certifications: [],
      links: [],
    };
    expect(validateProvenance(x, text)).toEqual({ ok: true });
  });

  it("rejects a role that is both current and has an end date", () => {
    const x = sampleExtract();
    const now = x.roles[0];
    if (now) now.endMonth = "2021-03";
    expect(validateProvenance(x, SAMPLE_RESUME)).toEqual({
      ok: false,
      failures: [{ item: "role", index: 0, problem: "current_with_end_date" }],
    });
  });

  it("names items by index and problem only, never by their text", () => {
    const x = sampleExtract();
    const atom = x.atoms[0];
    if (atom) atom.sourceQuote = "A sentence that is not there.";
    expect(JSON.stringify(validateProvenance(x, SAMPLE_RESUME))).not.toContain("sentence");
  });
});
