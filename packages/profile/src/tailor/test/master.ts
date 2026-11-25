import type { MasterResume, TailorJob } from "../types.js";

// A synthetic master resume (the same invented person as ../../test/sample.ts). Public repo:
// never put a real resume here.
export function sampleMaster(): MasterResume {
  return {
    roles: [
      {
        id: "role-1",
        employer: "Example Payments",
        title: "Senior Software Engineer",
        startMonth: "2021-03",
        endMonth: null,
        isCurrent: true,
      },
      {
        id: "role-2",
        employer: "Sample Logistics",
        title: "Software Engineer",
        startMonth: "2017-06",
        endMonth: "2021-02",
        isCurrent: false,
      },
    ],
    education: [
      {
        school: "Example State University",
        degree: "BSc",
        field: "Computer Science",
        endMonth: "2017",
      },
    ],
    atoms: [
      {
        id: "atom-1",
        roleId: "role-1",
        what: "Made payment retries idempotent",
        how: ["Go", "Postgres"],
        sourceQuote:
          "• Made payment retries idempotent in Go and Postgres, cutting duplicate charges to zero.",
      },
      {
        id: "atom-2",
        roleId: "role-1",
        what: "Led a team of 4 engineers through the ledger migration",
        how: [],
        sourceQuote:
          "• Led a team of 4 engineers through the ledger migration, moving 120 million rows with no downtime.",
      },
      {
        id: "atom-3",
        roleId: "role-1",
        what: "Wrote the on-call runbook",
        how: ["Terraform"],
        sourceQuote: "• Wrote the on-call runbook and the Terraform for its alerts.",
      },
      {
        id: "atom-4",
        roleId: "role-2",
        what: "Built a route planner that cut planning time by 35%",
        how: ["Python"],
        sourceQuote: "• Built a route planner in Python that cut planning time by 35%.",
      },
      {
        id: "atom-5",
        roleId: null,
        what: "Open-source Kafka consumer library",
        how: ["Kafka"],
        sourceQuote: "• Maintain an open-source Kafka consumer library.",
      },
    ],
    skills: ["Go", "Postgres", "Python", "Kafka"],
  };
}

// A synthetic posting: Terraform is proven by an atom but missing from the skills section;
// Kubernetes is nowhere in the profile.
export function sampleJob(): TailorJob {
  return {
    title: "Senior Platform Engineer",
    requirements: ["Terraform", "Kubernetes", "Production Postgres experience"],
    niceToHaves: ["Python"],
  };
}
