import {
  PREFERENCE_DEFAULTS,
  type PreferenceValues,
  type ScorableJob,
  type ScoringProfile,
} from "@northstar/db";

// Synthetic profile, job and preferences for the fit tests (invented company and work history).

// a1 stands for TypeScript and PostgreSQL (its `how`) and Go (a listed skill its text names).
// a2 stands for Kubernetes. Terraform is a listed skill no atom names, so it meets nothing.
export const PROFILE: ScoringProfile = {
  sourceId: "00000000-0000-4000-8000-0000000000aa",
  atoms: [
    { id: "a1", what: "Built the billing service in Go", how: ["TypeScript", "PostgreSQL"] },
    { id: "a2", what: "Ran the Kubernetes clusters", how: ["Kubernetes"] },
  ],
  skills: ["Go", "Terraform"],
};

export const JOB: ScorableJob = {
  id: "j1",
  title: "Senior Backend Engineer",
  location: "Remote (US)",
  remote: "remote",
  salaryMin: 150_000,
  salaryMax: 180_000,
  salaryCurrency: "USD",
  salaryPeriod: "year",
  seniority: null,
  requirements: [
    "5+ years with TypeScript",
    "PostgreSQL at scale",
    "Experience with Rust",
    "Kubernetes in production",
  ],
  niceToHaves: ["Terraform", "Payments experience"],
  description: "Globex builds billing software.",
};

export const PREFS: PreferenceValues = {
  ...PREFERENCE_DEFAULTS,
  titles: ["Backend Engineer"],
  seniority: ["Senior"],
  remote: ["remote"],
  compFloor: 140_000,
};
