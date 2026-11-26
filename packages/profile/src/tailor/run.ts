import type {
  SaveTailoredInput,
  TailorInput,
  TailorInputError,
  TailorSummary,
} from "@northstar/db";
import { applySkillToggles, diffResume, type ResumeDiff } from "./diff.js";
import { preSendScoreFromPdf, tailorToPages } from "./fit.js";
import { renderResumePdf } from "./pdf.js";
import type { PreSendScore } from "./score.js";
import type { MasterResume, TailoredResume, TailorJob } from "./types.js";
import { type TailorValidation, validateTailoredResume } from "./validate.js";

// Tailoring a stored job end to end (NS-146, TLR-001/003/005): plain code, no model. Read the
// master and the job, fit one page, apply Paul's toggles, validate, score on the PDF, diff, store.

export type TailorRunDeps = {
  readInput: (
    jobId: string,
  ) => Promise<{ ok: true; value: TailorInput } | { ok: false; error: TailorInputError }>;
  save: (
    input: Omit<SaveTailoredInput, "candidateId">,
  ) => Promise<{ version: number; saved: boolean }>;
};

export type TailorRun =
  | { kind: "refused"; reason: TailorInputError["kind"] }
  // Only skills the tailor added can be turned off; a skill the master lists stays (TLR-003).
  | { kind: "bad_toggle"; names: string[] }
  | {
      kind: "tailored";
      master: MasterResume;
      resume: TailoredResume;
      validation: TailorValidation;
      score: PreSendScore;
      diff: ResumeDiff;
      pages: number;
      version: number;
      saved: boolean;
    };

export async function tailorForJob(
  deps: TailorRunDeps,
  jobId: string,
  requested: readonly string[],
): Promise<TailorRun> {
  // "Terraform,terraform" is one toggle: the event's count must match the stored list.
  const seen = new Set<string>();
  const drop = requested.filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const input = await deps.readInput(jobId);
  if (!input.ok) return { kind: "refused", reason: input.error.kind };
  const master: MasterResume = input.value.master;
  const job: TailorJob = {
    title: input.value.job.title,
    requirements: input.value.job.requirements,
    niceToHaves: input.value.job.niceToHaves,
  };
  const fitted = await tailorToPages(master, job);
  const added = new Set(
    fitted.resume.skills.filter((s) => s.added).map((s) => s.name.toLowerCase()),
  );
  const bad = drop.filter((name) => !added.has(name.toLowerCase()));
  if (bad.length > 0) return { kind: "bad_toggle", names: bad };
  const resume = applySkillToggles(fitted.resume, [...drop]);
  // Toggles change the page: score what will actually be sent.
  const pdf = drop.length === 0 ? fitted.pdf : await renderResumePdf(resume, master);
  const validation = validateTailoredResume(resume, master, job);
  const score = await preSendScoreFromPdf({ master, job, resume, pdf: pdf.bytes });
  const diff = diffResume(master, resume);
  const { version, saved } = await deps.save({
    jobId: input.value.job.id,
    profileSourceId: input.value.profileSourceId,
    resume,
    validation,
    score,
    droppedSkills: [...drop],
    summary: summarize(resume, validation, score, drop.length),
  });
  return {
    kind: "tailored",
    master,
    resume,
    validation,
    score,
    diff,
    pages: pdf.pages,
    version,
    saved,
  };
}

// Counts and flags for the event: never a line, skill or requirement.
function summarize(
  resume: TailoredResume,
  validation: TailorValidation,
  score: PreSendScore,
  dropped: number,
): TailorSummary {
  const lines = [...resume.summary, ...resume.sections.flatMap((s) => s.lines)];
  return {
    lines: lines.length,
    atoms: new Set(lines.flatMap((l) => l.atomIds)).size,
    addedSkills: resume.skills.filter((s) => s.added).length,
    droppedSkills: dropped,
    notClaimed: resume.notClaimed.length,
    keywordsCovered: score.keywords.covered,
    keywordsTotal: score.keywords.total,
    titleMatch: score.title,
    atsPass: score.ats.pass,
    valid: validation.ok,
    failures: validation.ok ? 0 : validation.failures.length,
  };
}
