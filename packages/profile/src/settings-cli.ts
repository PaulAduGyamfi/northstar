import type { ProfileSettingView, SettingRefusal } from "@northstar/db";
import { answerFactual, parseQualifier, parseSettingValue, QUALIFIED_FIELDS } from "./factual.js";
import { FACTUAL_FIELDS, type FactualField } from "./question-canon.js";

// `profile settings set|show` and `profile answer` (NS-141, ANS-001): Paul's answers to factual
// application questions, checked by plain code. These print Paul's own settings back to Paul.

export type SettingsDeps = {
  print: (line: string) => void;
  setSetting: (
    field: FactualField,
    value: string,
    qualifier?: string,
  ) => Promise<{ ok: true; value: { saved: boolean } } | { ok: false; error: SettingRefusal }>;
  readSettings: () => Promise<ProfileSettingView[]>;
  recordFactualUse: (use: {
    canonicalId: string;
    field: FactualField;
    confidence: number;
  }) => Promise<void>;
};

const isField = (f: string): f is FactualField => (FACTUAL_FIELDS as readonly string[]).includes(f);

const VALUE_HELP: Record<string, string> = {
  not_yes_no: "yes or no",
  not_whole_years: "a whole number of years (0 to 60)",
  not_iso_date: "a date as YYYY-MM-DD",
  not_arrangement: "remote, hybrid or onsite",
  not_https_url: "an https:// link with no user name or password",
  bad_text: "one line of at most 200 characters",
};

// `profile settings set <field> <value> [--for <qualifier>]`.
export async function settingsSetCommand(
  deps: SettingsDeps,
  field: string,
  raw: string,
  rawQualifier?: string,
): Promise<number> {
  if (!isField(field)) {
    deps.print(`Not saved: unknown field. Fields: ${FACTUAL_FIELDS.join(", ")}`);
    return 1;
  }
  const keyed = QUALIFIED_FIELDS.has(field);
  if (keyed && rawQualifier === undefined) {
    deps.print(`Not saved: ${field} needs --for <skill, country or company>.`);
    return 1;
  }
  if (!keyed && rawQualifier !== undefined) {
    deps.print(`Not saved: ${field} takes no --for.`);
    return 1;
  }
  const qualifier = rawQualifier === undefined ? undefined : parseQualifier(rawQualifier);
  if (qualifier === null) {
    deps.print("Not saved: --for takes one line of at most 100 characters.");
    return 1;
  }
  const parsed = parseSettingValue(field, raw);
  if (!parsed.ok) {
    deps.print(`Not saved: ${field} takes ${VALUE_HELP[parsed.error]}.`);
    return 1;
  }
  const result = await deps.setSetting(field, parsed.value, qualifier);
  if (!result.ok) {
    deps.print(`Not saved (${result.error.reason}).`);
    return 1;
  }
  const label = qualifier === undefined ? field : `${field} (${qualifier})`;
  deps.print(result.value.saved ? `Saved ${label}.` : `${label} already has that value.`);
  return 0;
}

// `profile settings show`: every current setting, one per line.
export async function settingsShowCommand(deps: SettingsDeps): Promise<number> {
  const settings = await deps.readSettings();
  if (settings.length === 0) {
    deps.print("No settings yet. Run: profile settings set <field> <value> [--for <qualifier>]");
    return 0;
  }
  for (const s of settings)
    deps.print(s.qualifier ? `${s.field} (${s.qualifier}): ${s.value}` : `${s.field}: ${s.value}`);
  return 0;
}

const UNANSWERED: Record<string, string> = {
  not_factual: "Not a factual question: it needs a drafted answer, not a setting.",
  no_setting: "No setting answers it yet.",
  no_qualifier: "No stored value for what it names (or it names more than one).",
  form_mismatch: "The question's form doesn't fit the stored value; answer it yourself.",
};

// `profile answer "<question>"`: the answer, the canonical question and the setting used.
export async function answerCommand(deps: SettingsDeps, question: string): Promise<number> {
  const settings = await deps.readSettings();
  const result = answerFactual(question, settings);
  if (result.status === "unanswered") {
    deps.print(UNANSWERED[result.reason] ?? result.reason);
    if (result.canonical) deps.print(`Matched: ${result.canonical.text}`);
    return 1;
  }
  const s = result.setting;
  deps.print(result.answer);
  // Two decimals, as the recorded event has it.
  const confidence = Math.round(result.confidence * 100) / 100;
  deps.print(`Matched: ${result.canonical.text} (confidence ${confidence})`);
  deps.print(`From: ${s.qualifier ? `${s.field} (${s.qualifier})` : s.field}`);
  deps.print("Check it before it goes on a form.");
  if (isField(s.field))
    await deps.recordFactualUse({
      canonicalId: result.canonical.id,
      field: s.field,
      confidence: result.confidence,
    });
  return 0;
}
