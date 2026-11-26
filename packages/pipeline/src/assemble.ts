import {
  APPLY_ATS,
  type ApplicationPackage,
  type ApplyAts,
  err,
  type InvalidPackage,
  ok,
  type PackageFacts,
  type PackageFile,
  packageSha256,
  parsePackage,
  type Result,
} from "@northstar/domain";
import {
  adaptAnswer,
  answerFactual,
  matchQuestion,
  narrativeKindOf,
  type Setting,
  type StoredAnswer,
} from "@northstar/profile";

// Application package assembly (NS-161, APPLY-001), as plain code with no model or I/O: every
// form answer comes from something Paul set or approved (a factual setting, ANS-001, or a banked
// answer, ANS-003), and anything else goes back to him as NeedsHuman, never a guess (ADR-0004).

// One question on the application form, as the ATS describes it.
export type FormQuestion = {
  // The form's own field name: the key in the package's field map.
  fieldName: string;
  label: string;
  required: boolean;
  // Characters, or null for no limit.
  maxLength: number | null;
  // The allowed values of a choice question; null for free text.
  choices: readonly string[] | null;
};

// A banked answer Paul approved (GH-59), by canonical question id.
export type BankEntry = StoredAnswer & { answerId: string; version: number };

export type AssemblyInput = {
  packageId: string;
  applicationId: string;
  ats: ApplyAts;
  postingId: string;
  applyUrl: string;
  // The company name from the job, for a banked answer's {company} slot.
  company: string | null;
  contact: ApplicationPackage["contact"];
  // The tailored resume (validated when stored, NS-146) and an optional cover letter.
  resume: PackageFile;
  coverLetter: PackageFile | null;
  coverLetterRequired: boolean;
  questions: readonly FormQuestion[];
  settings: readonly Setting[];
  bank: ReadonlyMap<string, BankEntry>;
  // The job's fit score (NS-116), or null when it has none.
  fit: number | null;
  formSeenBefore: boolean;
};

// Where an answer came from, so Paul (and the Gate's policy) can trace every value.
export type AnswerSource =
  | { fieldName: string; from: "setting"; field: string; qualifier: string }
  | {
      fieldName: string;
      from: "bank";
      answerId: string;
      version: number;
      variant: "long" | "short";
      confidence: number;
    };

// Why one question can't be answered without Paul.
export type Unanswered = {
  fieldName: string;
  reason:
    | "no_setting"
    | "no_qualifier"
    | "form_mismatch"
    | "not_matched"
    | "no_bank_answer"
    | "too_long"
    | "missing_slot"
    | "unsafe_company"
    | "not_a_choice"
    | "cover_letter";
};

export type Assembled = {
  package: ApplicationPackage;
  sha256: string;
  facts: PackageFacts;
  sources: AnswerSource[];
};
export type NeedsHuman = { kind: "NeedsHuman"; unanswered: Unanswered[] };

// A banked answer counts as exact reuse only when the question matched its canonical wording
// fully; any other match is "high confidence" for the Gate's policy (APPLY-004).
const EXACT_MATCH = 1;

type Answer =
  | { ok: true; value: string; source: AnswerSource; freeText: boolean }
  | { ok: false; reason: Unanswered["reason"] };

function answer(q: FormQuestion, input: AssemblyInput): Answer {
  const factual = answerFactual(q.label, input.settings);
  if (factual.status === "answered") {
    const { field, qualifier } = factual.setting;
    return {
      ok: true,
      value: factual.answer,
      source: { fieldName: q.fieldName, from: "setting", field, qualifier },
      freeText: false,
    };
  }
  // A factual question whose setting is missing or doesn't fit: never drafted around.
  if (factual.reason !== "not_factual") return { ok: false, reason: factual.reason };
  const match = matchQuestion(q.label);
  if (match.status !== "matched" || narrativeKindOf(match.canonical.id) === null) {
    return { ok: false, reason: "not_matched" };
  }
  const entry = input.bank.get(match.canonical.id);
  if (entry === undefined) return { ok: false, reason: "no_bank_answer" };
  const adapted = adaptAnswer(entry, { company: input.company, maxLength: q.maxLength });
  if (adapted.status !== "ok") return { ok: false, reason: adapted.status };
  return {
    ok: true,
    value: adapted.text,
    source: {
      fieldName: q.fieldName,
      from: "bank",
      answerId: entry.answerId,
      version: entry.version,
      variant: adapted.variant,
      confidence: match.confidence,
    },
    freeText: true,
  };
}

// The choice the form offers that equals the answer (case and spacing aside), or null.
function pickChoice(choices: readonly string[], value: string): string | null {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return choices.find((c) => norm(c) === norm(value)) ?? null;
}

const words = (text: string) => text.split(/\s+/).filter((w) => w.length > 0).length;

export function assemblePackage(
  input: AssemblyInput,
): Result<Assembled, NeedsHuman | InvalidPackage> {
  const unanswered: Unanswered[] = [];
  if (input.coverLetterRequired && input.coverLetter === null) {
    unanswered.push({ fieldName: "cover_letter", reason: "cover_letter" });
  }
  const fields: Record<string, string> = {};
  const sources: AnswerSource[] = [];
  const factsAnswers: PackageFacts["answers"] = [];
  for (const q of input.questions) {
    const found = answer(q, input);
    let value: string | null = null;
    let reason: Unanswered["reason"] | null = found.ok ? null : found.reason;
    if (found.ok) {
      value = q.choices === null ? found.value : pickChoice(q.choices, found.value);
      if (value === null) reason = "not_a_choice";
    }
    if (!found.ok || value === null) {
      // An optional question stays blank rather than guessed; a required one needs Paul.
      if (q.required) unanswered.push({ fieldName: q.fieldName, reason: reason ?? "not_matched" });
      continue;
    }
    fields[q.fieldName] = value;
    sources.push(found.source);
    factsAnswers.push({
      // Factual settings are marked for Paul's review (NS-141), so they never count as reuse.
      source:
        found.source.from === "setting"
          ? "new"
          : found.source.confidence >= EXACT_MATCH
            ? "bank_exact"
            : "bank_high_confidence",
      freeTextWords: found.freeText && q.choices === null ? words(value) : 0,
    });
  }
  if (unanswered.length > 0) return err({ kind: "NeedsHuman", unanswered });

  const parsed = parsePackage({
    packageId: input.packageId,
    applicationId: input.applicationId,
    ats: input.ats,
    postingId: input.postingId,
    applyUrl: input.applyUrl,
    contact: input.contact,
    resume: input.resume,
    coverLetter: input.coverLetter,
    fields,
  });
  if (!parsed.ok) return parsed;
  const facts: PackageFacts = {
    fit: input.fit,
    // Every ATS a package can name has a deterministic adapter (APPLY-002).
    adapter: (APPLY_ATS as readonly string[]).includes(input.ats) ? "known" : "generic",
    formSeenBefore: input.formSeenBefore,
    answers: factsAnswers,
  };
  return ok({ package: parsed.value, sha256: packageSha256(parsed.value), facts, sources });
}
