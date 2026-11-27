import {
  type ApplicationPackage,
  type ApplyAts,
  err,
  type InvalidPackage,
  isExactWording,
  ok,
  type PackageFacts,
  type PackageFile,
  packageSha256,
  parsePackage,
  REUSE_HIGH_CONFIDENCE,
  type Result,
} from "@northstar/domain";
import {
  adaptAnswer,
  answerFactual,
  type ConfirmedMatch,
  confirmCandidates,
  isNegatedQuestion,
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
  // Matches the caller confirmed with confirmQuestion before assembly (NS-233), by field name.
  // Optional: without it every question is matched by code alone.
  confirmed?: ReadonlyMap<string, ConfirmedMatch>;
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
      // The label is the canonical question's own wording (see bankSource).
      exactWording: boolean;
      // Who chose the canonical question (NS-233): code's lexical match, or the model's pick in
      // confirmQuestion. A model's pick is never reuse for the Gate's policy.
      confirmedBy: "rules" | "model";
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

// How a reused banked answer counts for the Gate's policy (APPLY-004): one rule in packages/domain
// (`question-reuse.ts`, NS-249), which the Gate applies again to the stored form's label, so the
// producer and the Gate can't count reuse differently.

// The model's pick for this field (NS-233), only where it could be one: code's own match of the
// label left it new, and the chosen question is one the confirm step offers for this label. Any
// other entry is ignored and code's match stands, so a stale map or a mixed-up field name can never
// carry a match the label doesn't earn. A rules entry is never trusted: code matches the label
// itself. Either flag marks a pick as the model's.
function modelPick(
  label: string,
  own: ReturnType<typeof matchQuestion>,
  entry: ConfirmedMatch | undefined,
): ReturnType<typeof matchQuestion> | null {
  const chosen = entry?.match;
  if (entry === undefined || chosen === undefined || chosen.status !== "matched") return null;
  const byModel = entry.by === "model" || chosen.confirmedBy === "model";
  if (!byModel || own.status === "matched") return null;
  const offered = confirmCandidates(label).some((c) => c.id === chosen.canonical.id);
  return offered ? chosen : null;
}

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
  const own = matchQuestion(q.label);
  const pick = modelPick(q.label, own, input.confirmed?.get(q.fieldName));
  const match = pick ?? own;
  const confirmedBy = pick === null ? "rules" : "model";
  if (
    match.status !== "matched" ||
    narrativeKindOf(match.canonical.id) === null ||
    // A negated label ("Why would you NOT…") asks the opposite of the banked question, and the
    // matcher drops "not" as filler: never reuse an answer for it (the shared check, NS-244).
    isNegatedQuestion(q.label)
  ) {
    return { ok: false, reason: "not_matched" };
  }
  const company = input.company ?? "";
  const exactWording = isExactWording(q.label, match.canonical, company);
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
      exactWording,
      confirmedBy,
    },
    freeText: true,
  };
}

// The choice the form offers that equals the answer (case and spacing aside), or null.
function pickChoice(choices: readonly string[], value: string): string | null {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return choices.find((c) => norm(c) === norm(value)) ?? null;
}

// The policy source of one answer (see REUSE_HIGH_CONFIDENCE, packages/domain).
export function bankSource(source: AnswerSource): PackageFacts["answers"][number]["source"] {
  // Factual settings are marked for Paul's review (NS-141), so they never count as reuse.
  if (source.from === "setting") return "new";
  // The model chose the canonical question (NS-233): a mistaken or injected pick must never skip
  // Paul's review, whatever its confidence or wording.
  if (source.confirmedBy === "model") return "new";
  if (source.exactWording) return "bank_exact";
  return source.confidence >= REUSE_HIGH_CONFIDENCE ? "bank_high_confidence" : "new";
}

const words = (text: string) => text.split(/\s+/).filter((w) => w.length > 0).length;

export function assemblePackage(
  input: AssemblyInput,
): Result<Assembled, NeedsHuman | InvalidPackage> {
  const unanswered: Unanswered[] = [];
  if (input.coverLetterRequired && input.coverLetter === null) {
    unanswered.push({ fieldName: "cover_letter", reason: "cover_letter" });
  }
  // Two questions with one field name would overwrite each other: refuse the form as given.
  const names = input.questions.map((q) => q.fieldName);
  const duplicates = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (duplicates.length > 0) return err({ kind: "InvalidPackage", fields: duplicates });
  // A Map, so a field named like an Object property ("__proto__") is kept as data.
  const fields = new Map<string, string>();
  const sources: AnswerSource[] = [];
  const factsAnswers: PackageFacts["answers"] = [];
  // No cover-letter drafting exists yet, so any cover letter is new text Paul must review.
  if (input.coverLetter !== null) factsAnswers.push({ source: "new", freeTextWords: 0 });
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
      // `reason` is always set here; the fallback only satisfies the type.
      if (q.required) unanswered.push({ fieldName: q.fieldName, reason: reason ?? "not_matched" });
      continue;
    }
    fields.set(q.fieldName, value);
    sources.push(found.source);
    factsAnswers.push({
      source: bankSource(found.source),
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
    fields: Object.fromEntries(fields),
  });
  if (!parsed.ok) return parsed;
  const facts: PackageFacts = {
    fit: input.fit,
    // Every ATS a package can name (APPLY_ATS) has a deterministic adapter (APPLY-002).
    adapter: "known",
    formSeenBefore: input.formSeenBefore,
    answers: factsAnswers,
  };
  return ok({ package: parsed.value, sha256: packageSha256(parsed.value), facts, sources });
}
