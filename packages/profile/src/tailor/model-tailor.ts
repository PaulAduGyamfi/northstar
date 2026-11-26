import type { CallRecord, LlmGateway } from "@northstar/llm";
import { NUMBER_WORDS, STARTERS } from "../answer/validate.js";
import { hasWhole, normalize } from "../validate.js";
import { type ResumeTailorInput, resumeTailorRoute } from "./route.js";
import { lineText, type TailorOptions, tailorResume } from "./tailor.js";
import type { Line, MasterResume, TailoredResume, TailorJob } from "./types.js";
import { type TailorFailure, validateTailoredResume } from "./validate.js";

// The model step of resume tailoring (TLR-001, NS-144). Code decides: the deterministic tailor
// picks and orders the lines, the model only rewords them and writes a summary, and plain code
// decides whether its version is used. Anything that fails falls back to the deterministic
// resume, so Paul always has one, and a failed model resume is never returned.

export type ModelTailorResult =
  | { kind: "model"; resume: TailoredResume; record: CallRecord }
  | {
      kind: "deterministic";
      resume: TailoredResume;
      // off: the route isn't turned on (ADR-0016 item 8: hand-written fixtures until Paul
      // records real ones).
      reason: "off" | "refused" | "truncated" | "invalid_output" | "provenance";
      failures: TailorFailure[];
      record: CallRecord | null;
    };

// Skills as name and added flag: the model may not add, drop or relabel one (TLR-002).
const skillKeys = (r: TailoredResume) =>
  r.skills.map((s) => `${s.name.toLowerCase()}|${s.added}`).sort();

// tailorWithModel's own rules on top of validateTailoredResume.
function sameClaims(output: TailoredResume, base: TailoredResume): TailorFailure[] {
  const failures: TailorFailure[] = [];
  // "not claimed: Kubernetes (no evidence)" is code's finding: the model can't remove or add one.
  if (JSON.stringify(output.notClaimed) !== JSON.stringify(base.notClaimed)) {
    failures.push({ item: "notClaimed", problem: "differs from the deterministic tailor's" });
  }
  if (JSON.stringify(skillKeys(output)) !== JSON.stringify(skillKeys(base))) {
    failures.push({ item: "skills", problem: "differ from the deterministic tailor's" });
  }
  // Selection, order and the page budget are the deterministic tailor's (TLR-001): the same
  // sections, in the same order, with the same atoms on each line. Only the text may change.
  if (JSON.stringify(structureOf(output)) !== JSON.stringify(structureOf(base))) {
    failures.push({ item: "sections", problem: "differ from the deterministic tailor's" });
  }
  return failures;
}

const structureOf = (r: TailoredResume) =>
  r.sections.map((s) => [s.roleId, s.lines.map((l) => l.atomIds)]);

// Model-written text names nothing its cited atoms don't (ADR-0004). The validator polices
// digits and known technology terms; free text can also carry an employer, a title or a number
// in words, so each capitalised word must come from the cited atoms (their line, what and how),
// their roles' title and employer, or the master's skills, and never from the job. Each number
// word must be in the cited atoms. Failures give a word's position, never the text.
// Names the job writes with a capital (its title, requirements and nice-to-haves), lower-cased,
// so "kubernetes" in a line is caught when only the job says "Kubernetes".
function jobNames(job: TailorJob): Set<string> {
  const text = [job.title ?? "", ...job.requirements, ...job.niceToHaves].join(" ");
  return new Set(
    (text.match(/[\p{L}\p{N}+#]+/gu) ?? [])
      .filter((w) => /\p{Lu}/u.test(w) && !STARTERS.has(w))
      .map((w) => w.toLowerCase()),
  );
}

// A number in words: a number word ("billion", "twenty"), a multiplier ("tenfold"), or a
// multiplying verb ("quadrupled").
const isNumberWord = (part: string) =>
  NUMBER_WORDS.has(part) || /fold$/.test(part) || /^(?:quadrupl|quintupl|sextupl)/.test(part);

function checkFreeText(
  item: string,
  line: Line,
  master: MasterResume,
  fromJob: ReadonlySet<string>,
): TailorFailure[] {
  const failures: TailorFailure[] = [];
  const cited = master.atoms.filter((a) => line.atomIds.includes(a.id));
  const roles = master.roles.filter((r) => cited.some((a) => a.roleId === r.id));
  const atomText = normalize(cited.flatMap((a) => [a.sourceQuote, a.what]).join(" \n "));
  const names = normalize(
    [
      atomText,
      ...cited.flatMap((a) => a.how),
      ...roles.flatMap((r) => [r.title, r.employer]),
      ...master.skills,
    ].join(" \n "),
  );
  const lowerNames = names.toLowerCase();
  const lowerAtoms = atomText.toLowerCase();
  const seen = new Set<string>();
  normalize(line.text)
    .split(" ")
    .forEach((raw, position) => {
      // Edge punctuation off ("Go." → "Go"), keeping name characters such as + and #.
      const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#]+$/gu, "");
      const lower = word.toLowerCase();
      // Parts of a joined word ("billion-row", "twenty-five") count on their own.
      const numberPart = lower.split(/[-/'’]/).find((p) => isNumberWord(p));
      if (numberPart !== undefined && !hasWhole(lowerAtoms, numberPart)) {
        failures.push({ item, problem: `number at word ${position} is not in its atoms` });
      }
      if (seen.has(word) || /^I(?:['’]\p{L}+)?$/u.test(word)) return;
      seen.add(word);
      const fail = () =>
        failures.push({
          item,
          problem: `name at word ${position} is not in its atoms or their roles`,
        });
      // A name the job writes with a capital counts in any case here ("kubernetes").
      if (fromJob.has(lower) && !hasWhole(lowerNames, lower)) {
        fail();
        return;
      }
      // Any capital, not only a first one: "eBay", "gRPC", "macOS" are names too.
      if (!/\p{Lu}/u.test(word)) return;
      // A line's first word is capitalised anyway: an opener, or a word the atoms hold in lower
      // case, isn't a name.
      if (position === 0 && (STARTERS.has(word) || hasWhole(lowerNames, lower))) return;
      if (!hasWhole(names, word)) fail();
    });
  return failures;
}

// The route's input for a master and a job: what tailorWithModel sends, and what the eval sends.
export function resumeTailorInput(
  master: MasterResume,
  job: TailorJob,
  base: TailoredResume,
): ResumeTailorInput {
  // The independent-work section isn't the model's to reword or see: it is Paul's own lines,
  // verbatim (NS-231), and leaving it out keeps the route's requests as they were.
  const { independentWork: _work, ...rewordable } = base;
  return {
    base: rewordable,
    atoms: master.atoms.map((a) => ({ id: a.id, roleId: a.roleId, line: lineText(a) })),
    roles: master.roles.map((r) => ({ id: r.id, title: r.title, employer: r.employer })),
    skills: master.skills,
    job,
  };
}

// Every check a model resume must pass: the provenance validator, then the same skills and
// not-claimed notes as the deterministic tailor's. Empty means it may be used.
export function checkModelResume(
  output: TailoredResume,
  master: MasterResume,
  job: TailorJob,
  base: TailoredResume,
): TailorFailure[] {
  const check = validateTailoredResume(output, master, job);
  const fromJob = jobNames(job);
  const free = [
    ...output.summary.flatMap((l, i) => checkFreeText(`summary line ${i}`, l, master, fromJob)),
    ...output.sections.flatMap((s, si) =>
      s.lines.flatMap((l, li) => checkFreeText(`section ${si} line ${li}`, l, master, fromJob)),
    ),
  ];
  return [...(check.ok ? [] : check.failures), ...free, ...sameClaims(output, base)];
}

export async function tailorWithModel(
  // `enabled` is false unless the caller turns the route on from config.
  deps: { gateway: LlmGateway; enabled?: boolean },
  master: MasterResume,
  job: TailorJob,
  options: TailorOptions = {},
): Promise<ModelTailorResult> {
  const base = tailorResume(master, job, options);
  const fallback = (
    reason: "off" | "refused" | "truncated" | "invalid_output" | "provenance",
    failures: TailorFailure[],
    record: CallRecord | null,
  ): ModelTailorResult => ({ kind: "deterministic", resume: base, reason, failures, record });
  if (deps.enabled !== true) return fallback("off", [], null);

  // A transport error throws, so the caller's retry policy handles it (llm.md).
  const outcome = await deps.gateway.call(
    resumeTailorRoute(),
    resumeTailorInput(master, job, base),
  );
  switch (outcome.kind) {
    case "Refused":
      return fallback("refused", [], outcome.record);
    case "Truncated":
      return fallback("truncated", [], outcome.record);
    case "InvalidOutput":
      return fallback("invalid_output", [], outcome.record);
    case "Ok": {
      const failures = checkModelResume(outcome.output, master, job, base);
      if (failures.length > 0) return fallback("provenance", failures, outcome.record);
      // Any section on the model's output is dropped here, not only by the schema's parse (which
      // could change), and the deterministic one goes back on as it was.
      const { independentWork: _fromModel, ...reworded } = outcome.output;
      const resume: TailoredResume =
        base.independentWork === undefined
          ? reworded
          : { ...reworded, independentWork: base.independentWork };
      return { kind: "model", resume, record: outcome.record };
    }
  }
}
