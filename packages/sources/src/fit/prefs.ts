import type { PreferenceValues, RemoteKind } from "@northstar/db";
import { err, ok, type Result } from "@northstar/domain";

// `jobs prefs set <field> <value>` (NS-116, SRC-017): one field's new value, checked in plain
// code before anything is stored. "-" clears a field.

export const PREFERENCE_FIELDS = [
  "titles",
  "seniority",
  "locations",
  "remote",
  "dealbreakers",
  "compFloor",
  "compTarget",
  "currency",
  "queueAt",
  "suggestAt",
] as const satisfies readonly (keyof PreferenceValues)[];
export type PreferenceField = (typeof PREFERENCE_FIELDS)[number];

export const isPreferenceField = (f: string): f is PreferenceField =>
  (PREFERENCE_FIELDS as readonly string[]).includes(f);

export type PreferenceError =
  | { kind: "UnknownField"; field: string }
  | { kind: "BadValue"; field: PreferenceField; why: string };

const REMOTE: RemoteKind[] = ["onsite", "hybrid", "remote"];
// Bounds so a stray paste can't store a novel as a preference.
const MAX_ITEMS = 50;
const MAX_ITEM_LENGTH = 100;

// A comma-separated list: items trimmed, empty ones dropped, repeats (ignoring case) kept once.
function list(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw.split(",").map((s) => s.trim())) {
    if (item === "" || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    out.push(item);
  }
  return out;
}

export function applyPreference(
  current: PreferenceValues,
  field: string,
  raw: string,
): Result<PreferenceValues, PreferenceError> {
  if (!isPreferenceField(field)) return err({ kind: "UnknownField", field });
  const f = field;
  const value = raw.trim();
  const clear = value === "-";
  const bad = (why: string) => err({ kind: "BadValue", field: f, why } as const);
  if (value === "") return bad("give a value, or - to clear it");

  switch (f) {
    case "titles":
    case "seniority":
    case "locations":
    case "dealbreakers": {
      const items = clear ? [] : list(value);
      if (items.length > MAX_ITEMS) return bad(`at most ${MAX_ITEMS} items`);
      if (items.some((i) => i.length > MAX_ITEM_LENGTH)) {
        return bad(`each item at most ${MAX_ITEM_LENGTH} characters`);
      }
      return ok({ ...current, [f]: items });
    }
    case "remote": {
      const items = clear ? [] : list(value.toLowerCase());
      if (!items.every((i) => (REMOTE as string[]).includes(i))) {
        return bad("onsite, hybrid or remote, comma-separated");
      }
      return ok({ ...current, remote: items as RemoteKind[] });
    }
    case "compFloor":
    case "compTarget": {
      if (!clear && !/^\d{1,9}$/.test(value)) return bad("a whole number per year, like 150000");
      const next = { ...current, [f]: clear ? null : Number(value) };
      if (next.compFloor !== null && next.compTarget !== null && next.compFloor > next.compTarget) {
        return bad("compFloor can't be above compTarget");
      }
      return ok(next);
    }
    case "currency":
      if (!/^[A-Za-z]{3}$/.test(value)) return bad("a three-letter code, like USD");
      return ok({ ...current, currency: value.toUpperCase() });
    case "queueAt":
    case "suggestAt": {
      if (!/^\d{1,3}$/.test(value) || Number(value) > 100) return bad("a whole number 0 to 100");
      const next = { ...current, [f]: Number(value) };
      if (next.suggestAt > next.queueAt) return bad("suggestAt can't be above queueAt");
      return ok(next);
    }
  }
}

// One field's value as Paul reads it.
export function showPreference(prefs: PreferenceValues, field: PreferenceField): string {
  const v = prefs[field];
  if (Array.isArray(v)) return v.length === 0 ? "-" : v.join(", ");
  return v === null ? "-" : String(v);
}
