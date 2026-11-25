import type { ProfileExtract } from "../schema.js";

// A synthetic resume (invented person, employer and school; example.com links). Public repo:
// never put a real resume here.
export const SAMPLE_RESUME = `Alex Example
alex@example.com · https://github.example.com/alex · https://portfolio.example.com

EXPERIENCE
Senior Software Engineer, Example Payments · March 2021 – Present
• Made payment retries idempotent in Go and Postgres, cutting duplicate charges to zero.
• Led a team of 4 engineers through the ledger
  migration, moving 120 million rows with no downtime.
• Wrote the on-call runbook.

Software Engineer, Sample Logistics · June 2017 – February 2021
• Built a route planner in Python that cut planning time by 35%.

EDUCATION
Example State University — BSc, Computer Science, 2017

SKILLS
Go, Postgres, Python, Kafka

CERTIFICATIONS
Example Cloud Associate (Example Cloud), January 2023
`;

// What a faithful extraction of SAMPLE_RESUME looks like.
export function sampleExtract(): ProfileExtract {
  return {
    roles: [
      {
        key: "r1",
        employer: "Example Payments",
        title: "Senior Software Engineer",
        startMonth: "2021-03",
        endMonth: null,
        current: true,
      },
      {
        key: "r2",
        employer: "Sample Logistics",
        title: "Software Engineer",
        startMonth: "2017-06",
        endMonth: "2021-02",
        current: false,
      },
    ],
    education: [
      {
        school: "Example State University",
        degree: "BSc",
        field: "Computer Science",
        startMonth: null,
        // The resume gives a year only: kept at year precision, never a guessed month.
        endMonth: "2017",
      },
    ],
    atoms: [
      {
        roleKey: "r1",
        what: "Made payment retries idempotent",
        how: ["Go", "Postgres"],
        impact: "cutting duplicate charges to zero",
        scope: null,
        startMonth: null,
        endMonth: null,
        sourceQuote:
          "Made payment retries idempotent in Go and Postgres, cutting duplicate charges to zero.",
        evidenceLink: null,
      },
      {
        roleKey: "r1",
        what: "Led the ledger migration",
        how: [],
        impact: "moving 120 million rows with no downtime",
        scope: "team of 4 engineers",
        startMonth: null,
        endMonth: null,
        // The resume wraps this bullet across two lines; the quote joins them with one space.
        sourceQuote:
          "Led a team of 4 engineers through the ledger migration, moving 120 million rows with no downtime.",
        evidenceLink: null,
      },
      {
        roleKey: "r2",
        what: "Built a route planner",
        how: ["Python"],
        impact: "cut planning time by 35%",
        scope: null,
        startMonth: null,
        endMonth: null,
        sourceQuote: "Built a route planner in Python that cut planning time by 35%.",
        evidenceLink: null,
      },
    ],
    skills: ["Go", "Postgres", "Python", "Kafka"],
    certifications: [
      { name: "Example Cloud Associate", issuer: "Example Cloud", issuedMonth: "2023-01" },
    ],
    links: [
      { label: "GitHub", url: "https://github.example.com/alex" },
      { label: "Portfolio", url: "https://portfolio.example.com" },
    ],
  };
}
