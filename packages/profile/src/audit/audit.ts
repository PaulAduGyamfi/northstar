import { NUMBER_WORDS } from "../answer/validate.js";
import { renderResumePdf } from "../tailor/pdf.js";
import { renderResumeText } from "../tailor/render.js";
import { atsParseCheck } from "../tailor/score.js";
import { lineText } from "../tailor/tailor.js";
import { mentions } from "../tailor/terms.js";
import type { MasterAtom, MasterResume, TailoredResume } from "../tailor/types.js";
import { pdfToText } from "../text.js";
import { normalize } from "../validate.js";
import { PRESENT_FORMS, WEAK_OPENERS } from "./verbs.js";

// The resume audit (NS-159, AUD-001): plain code, no model, no database. It scores the master
// resume and suggests changes line by line. A suggestion never proposes a number or a fact: a
// missing result becomes a question for Paul (AUD-003), and a missing date points to his official
// record, because dates are locked (CPG-004). Messages hold no number of their own, so the only
// numbers in them are words quoted from the master or a target term.

export type AuditDimension = "impact" | "verbs" | "ats" | "length" | "keywords" | "consistency";

export type SuggestionKind =
  | "missing_metric"
  | "weak_opener"
  | "tense"
  | "long_line"
  | "missing_date"
  | "missing_keyword"
  | "ats";

// What a suggestion is about: one atom's resume line, a role, a target term, or the whole resume.
export type SuggestionTarget =
  | { atomId: string }
  | { roleId: string }
  | { term: string }
  | { resume: true };

export type Suggestion = {
  // `<kind>:<target>`: the same master and targets give the same ids, so a decision can be
  // stored against one.
  id: string;
  kind: SuggestionKind;
  dimension: AuditDimension;
  target: SuggestionTarget;
  message: string;
};

export type ResumeAudit = {
  // 0 to 100 each.
  scores: Record<AuditDimension, number>;
  // The rounded mean of the six.
  overall: number;
  // Pages of the full master rendered as the tailored resumes are (ADR-0020).
  pages: number;
  // Per atom in master order, then roles, then target terms, then the whole resume.
  suggestions: Suggestion[];
};

// A bullet over this many characters wraps past two lines of the page (about 100 characters each).
export const LONG_LINE = 200;
// Points the length score loses for each page past the first.
const PAGE_PENALTY = 25;

// Every atom in master order, every role and every master skill: the master as one resume, the
// way the tailor would render it with nothing dropped.
export function fullResume(master: MasterResume): TailoredResume {
  const linesFor = (roleId: string | null) =>
    master.atoms
      .filter((a) => a.roleId === roleId)
      .map((a) => ({ text: lineText(a), atomIds: [a.id] }));
  const sections: TailoredResume["sections"] = master.roles.map((r) => ({
    roleId: r.id,
    lines: linesFor(r.id),
  }));
  if (master.atoms.some((a) => a.roleId === null))
    sections.push({ roleId: null, lines: linesFor(null) });
  return {
    summary: [],
    sections,
    skills: master.skills.map((name) => ({ name, atomIds: [], added: false })),
    notClaimed: [],
  };
}

// The share as a whole percentage; nothing to check counts as full marks.
const percent = (good: number, total: number) =>
  total === 0 ? 100 : Math.round((100 * good) / total);

// A measured result: a digit, or a number word ("zero", "twice", "half").
function hasMetric(line: string): boolean {
  if (/\p{N}/u.test(line)) return true;
  return (line.toLowerCase().match(/\p{L}+/gu) ?? []).some((w) => NUMBER_WORDS.has(w));
}

// The weak opener a line starts with, in the line's own case, or null.
function weakOpener(line: string): string | null {
  const lower = line.toLowerCase();
  const found = WEAK_OPENERS.find((o) => new RegExp(`^${o}(?![\\p{L}])`, "u").test(lower));
  return found === undefined ? null : line.slice(0, found.length);
}

// The line's first word when it is a present form of a known verb ("Manages", "Leading").
function presentOpener(line: string): string | null {
  const first = line.match(/^\p{L}+/u)?.[0];
  return first !== undefined && PRESENT_FORMS.has(first.toLowerCase()) ? first : null;
}

const atomSuggestion = (
  kind: SuggestionKind,
  dimension: AuditDimension,
  atom: MasterAtom,
  message: string,
): Suggestion => ({
  id: `${kind}:${atom.id}`,
  kind,
  dimension,
  target: { atomId: atom.id },
  message,
});

export async function auditResume(master: MasterResume, targets: string[]): Promise<ResumeAudit> {
  const suggestions: Suggestion[] = [];
  const pastRoles = new Set(master.roles.filter((r) => !r.isCurrent).map((r) => r.id));
  let measured = 0;
  let strong = 0;
  let consistentChecks = 0;
  let consistentPassed = 0;

  for (const atom of master.atoms) {
    const line = lineText(atom);
    if (hasMetric(line)) measured++;
    else
      suggestions.push(
        atomSuggestion(
          "missing_metric",
          "impact",
          atom,
          "No measured result. What changed, and by how much? Answer only from what you know; skip it if there is no number.",
        ),
      );

    const weak = weakOpener(line);
    if (weak === null) strong++;
    else
      suggestions.push(
        atomSuggestion(
          "weak_opener",
          "verbs",
          atom,
          `Opens with "${weak}". Start with what you did, with an action verb.`,
        ),
      );

    // Tense is checked only in past roles: present tense is right in the current role, and a
    // project has no end.
    if (atom.roleId !== null && pastRoles.has(atom.roleId)) {
      consistentChecks++;
      const present = presentOpener(line);
      if (present === null) consistentPassed++;
      else
        suggestions.push(
          atomSuggestion(
            "tense",
            "consistency",
            atom,
            `"${present}" is present tense in a past role. Use the past tense.`,
          ),
        );
    }

    if (line.length > LONG_LINE)
      suggestions.push(
        atomSuggestion(
          "long_line",
          "length",
          atom,
          "This bullet is long enough to crowd the page. Keep the result and cut the rest.",
        ),
      );
  }

  // Dates are locked facts (CPG-004): the audit only points Paul to his official record.
  for (const role of master.roles) {
    consistentChecks++;
    const missing: string[] = [];
    if (role.startMonth === null) missing.push("start date");
    if (!role.isCurrent && role.endMonth === null) missing.push("end date");
    if (missing.length === 0) {
      consistentPassed++;
      continue;
    }
    suggestions.push({
      id: `missing_date:${role.id}`,
      kind: "missing_date",
      dimension: "consistency",
      target: { roleId: role.id },
      message: `This role has no ${missing.join(" or ")}. Dates are locked: set them in your official record (profile facts set), then import the resume again.`,
    });
  }

  // Each distinct target term (ignoring case) the master names anywhere: a role's title, a line,
  // an atom's summary or technologies, or the skills.
  const masterText = [
    ...master.roles.map((r) => r.title),
    ...master.atoms.flatMap((a) => [a.what, a.sourceQuote, ...a.how]),
    ...master.skills,
  ].join("\n");
  const seen = new Set<string>();
  const terms = targets
    .map((t) => normalize(t))
    .filter((t) => {
      const key = t.toLowerCase();
      if (t === "" || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  let covered = 0;
  for (const term of terms) {
    if (mentions(masterText, term)) {
      covered++;
      continue;
    }
    suggestions.push({
      id: `missing_keyword:${term.toLowerCase()}`,
      kind: "missing_keyword",
      dimension: "keywords",
      target: { term },
      message: `Your target roles ask for ${term}, which the resume never names. Add it only if you have done it, to the line where you did.`,
    });
  }

  // The master rendered and read back the way the pre-send check reads a tailored resume.
  const resume = fullResume(master);
  const pdf = await renderResumePdf(resume, master);
  const ats = atsParseCheck(renderResumeText(resume, master), await pdfToText(pdf.bytes));
  if (!ats.pass)
    suggestions.push({
      id: "ats:resume",
      kind: "ats",
      dimension: "ats",
      target: { resume: true },
      message:
        "Reading the PDF back loses words or a section header. Look for characters the standard font can't show, such as symbols or another script.",
    });
  // Each missing header costs as much as a tenth of the words.
  const atsScore = Math.max(0, Math.round(100 * ats.recovered) - 10 * ats.missingHeaders.length);

  const scores: Record<AuditDimension, number> = {
    impact: percent(measured, master.atoms.length),
    verbs: percent(strong, master.atoms.length),
    ats: atsScore,
    length: Math.max(0, 100 - PAGE_PENALTY * (pdf.pages - 1)),
    keywords: percent(covered, terms.length),
    consistency: percent(consistentPassed, consistentChecks),
  };
  const values = Object.values(scores);
  const overall = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  return { scores, overall, pages: pdf.pages, suggestions };
}
