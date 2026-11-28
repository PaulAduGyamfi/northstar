import {
  type Citation,
  type CompanySnapshot,
  quotable,
  type SnapshotJob,
  type SnapshotLine,
  snapshotLineProblem,
} from "./company-snapshot.js";

// The Prep Coach's interview brief (NS-283 slice 1, CAL-005), plain code with no I/O and no model.
// For one interview it puts together what the caller already computed from storage: the company
// snapshot, the job's must-haves matched to Paul's atoms (the Fit Score's `matchRequirements`) with
// the stories and atoms the caller picked as proof (`selectEvidence`), and the must-haves nothing
// proves, as gaps to prepare. Every line cites a job, an atom or a story (ADR-0004), and
// `checkInterviewBrief` refuses one that doesn't.

export type BriefSection = "role" | "about" | "roles" | "stack" | "match" | "gap";

export type BriefLine = { section: BriefSection; text: string; cites: Citation[] };

export type InterviewBrief = { jobId: string; lines: BriefLine[] };

export type BriefInput = {
  // The interview's job: its title is the role recap, its requirements back match and gap lines.
  job: SnapshotJob;
  snapshot: CompanySnapshot;
  // Each must-have the rules matched, with the proof the caller selected (an atom's or story's id).
  matched: readonly { requirement: string; proof: readonly Citation[] }[];
  // The must-haves nothing matched.
  gaps: readonly string[];
};

const jobCite = (id: string): Citation => ({ source: "job", id });

export function buildInterviewBrief(input: BriefInput): InterviewBrief {
  const { job, snapshot } = input;
  const fromSnapshot = (section: "about" | "roles" | "stack", lines: SnapshotLine[]) =>
    lines.map((l) => ({ section, text: l.text, cites: l.cites }));
  const lines: BriefLine[] = [
    { section: "role", text: job.title.trim(), cites: [jobCite(job.id)] },
    ...fromSnapshot("about", snapshot.about),
    // Other open roles: the interview's own job is already the recap.
    ...fromSnapshot(
      "roles",
      snapshot.roles.filter((l) => !l.cites.some((c) => c.source === "job" && c.id === job.id)),
    ),
    ...fromSnapshot("stack", snapshot.stack),
    ...input.matched
      // A must-have with no proof picked has nothing to cite: it is left out, not shown bare.
      .filter((m) => m.proof.length > 0)
      .map((m) => ({
        section: "match" as const,
        text: m.requirement,
        cites: [jobCite(job.id), ...m.proof],
      })),
    ...input.gaps.map((g) => ({ section: "gap" as const, text: g, cites: [jobCite(job.id)] })),
  ];
  return { jobId: job.id, lines };
}

export type BriefProblem = {
  index: number;
  reason:
    | "uncited"
    | "unknown_source"
    | "not_verbatim"
    | "not_quotable"
    | "no_proof"
    | "gap_with_proof"
    // A role, match or gap line that cites another saved job than the interview's.
    | "other_job"
    | "off_company"
    | "closed_job"
    | "over_limit";
};

// What the brief may cite: the saved jobs (the snapshot's and the interview's), and the atom and
// story ids the caller read from Paul's current profile.
export type BriefSources = {
  // The company the snapshot is of: an about line must name it.
  company: string;
  jobs: readonly SnapshotJob[];
  atomIds: ReadonlySet<string>;
  storyIds: ReadonlySet<string>;
};

// Refuses any line that cites nothing or an unknown job, atom or story, and any line that says
// more than its sources: the role line is a cited job's title; about, roles and stack lines follow
// the snapshot's own check (the company named, open roles, each section's maximum); a match line is one of the cited job's requirements, verbatim, with at
// least one atom or story as proof; a gap line is one of the cited job's requirements and cites no
// atom or story (a gap has no proof by definition). Plain code, no model (ADR-0004).
export function checkInterviewBrief(brief: InterviewBrief, sources: BriefSources): BriefProblem[] {
  const jobs = new Map(sources.jobs.map((j) => [j.id, j]));
  const problems: BriefProblem[] = [];
  // Each snapshot section's lines so far, for the section's maximum.
  const seen = { about: 0, roles: 0, stack: 0 };
  brief.lines.forEach((line, index) => {
    const position =
      line.section === "about" || line.section === "roles" || line.section === "stack"
        ? seen[line.section]++
        : 0;
    const reason = lineProblem(line, position, brief.jobId, jobs, sources);
    if (reason) problems.push({ index, reason });
  });
  return problems;
}

function lineProblem(
  line: BriefLine,
  // A snapshot line's position in its section.
  position: number,
  // The interview's job: role, match and gap lines are about it alone.
  jobId: string,
  jobs: ReadonlyMap<string, SnapshotJob>,
  sources: BriefSources,
): BriefProblem["reason"] | null {
  if (line.cites.length === 0) return "uncited";
  for (const c of line.cites) {
    const known =
      c.source === "job"
        ? jobs.has(c.id)
        : c.source === "atom"
          ? sources.atomIds.has(c.id)
          : sources.storyIds.has(c.id);
    if (!known) return "unknown_source";
  }
  if (line.section === "about" || line.section === "roles" || line.section === "stack") {
    // Snapshot lines cite jobs only.
    if (line.cites.some((c) => c.source !== "job")) return "not_verbatim";
    return snapshotLineProblem(line.section, position, line, jobs, sources.company);
  }
  if (!quotable(line.text)) return "not_quotable";
  const jobCites = line.cites.filter((c) => c.source === "job");
  if (jobCites.some((c) => c.id !== jobId)) return "other_job";
  const citedJobs = jobCites.flatMap((c) => {
    const job = jobs.get(c.id);
    return job ? [job] : [];
  });
  const proof = line.cites.filter((c) => c.source !== "job");
  if (line.section === "role") {
    if (proof.length > 0) return "not_verbatim";
    return citedJobs.some((j) => j.title.trim() === line.text) ? null : "not_verbatim";
  }
  const asked = citedJobs.some((j) => j.requirements.includes(line.text));
  if (line.section === "gap") {
    if (proof.length > 0) return "gap_with_proof";
    return asked ? null : "not_verbatim";
  }
  // A match line.
  if (proof.length === 0) return "no_proof";
  return asked ? null : "not_verbatim";
}
