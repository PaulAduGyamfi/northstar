import { normalize } from "../validate.js";
import type { MasterAtom } from "./types.js";

// Characters that continue a technology name: "Go" isn't in "Google", "C" isn't in "C#" or "C++".
// The same rule as fit scoring's namesTerm (packages/sources/src/fit/match.ts), which this
// package can't import (sources doesn't depend on profile, nor profile on sources).
const NAME_CHAR = "A-Za-z0-9+#";

// True when `text` names `term` as a whole name, ignoring case and typography.
export function mentions(text: string, term: string): boolean {
  const t = normalize(term);
  if (t === "") return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![${NAME_CHAR}])${escaped}(?![${NAME_CHAR}])`, "i").test(normalize(text));
}

// The terms an atom stands for: its `how` items, plus every master skill its own text names
// ("Built the billing service in Go" stands for Go when Go is a listed skill). Distinct, ignoring
// case, `how` first.
export function atomTerms(atom: MasterAtom, skills: string[]): string[] {
  const own = `${atom.what}\n${atom.sourceQuote}`;
  const all = [...atom.how, ...skills.filter((s) => mentions(own, s))];
  const seen = new Set<string>();
  return all.filter((t) => {
    const key = t.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Words in job text that look like a technology or product name, so the validator can police
// them even when nothing in Paul's profile knows them ("Kubernetes" in "Experience with
// Kubernetes"): a word with a capital after its first letter (PostgreSQL, GraphQL, iOS), one
// with a digit or + or # in it (S3, C++, C#), or one starting with a capital that isn't the
// first word of its text (the first word is capitalised anyway). Plus each requirement whole.
// A heuristic: lower-case names ("terraform") and names that open a requirement ("Kubernetes
// experience") are caught only when the whole requirement matches.
export function jobTerms(texts: string[]): string[] {
  const out = new Set<string>();
  for (const text of texts) {
    const t = normalize(text);
    if (t !== "") out.add(t);
    const words = t.match(/[\p{L}\p{N}][\p{L}\p{N}+#./-]*/gu) ?? [];
    words.forEach((raw, i) => {
      const w = raw.replace(/[./-]+$/, "");
      const named = /^.+\p{Lu}/u.test(w) || /[\p{N}+#]/u.test(w) || (i > 0 && /^\p{Lu}/u.test(w));
      if (named && w.length >= 2) out.add(w);
    });
  }
  return [...out];
}

// True when the atom's own text (`what`, `how` or resume line) names the term.
export function atomNames(atom: MasterAtom, term: string): boolean {
  return (
    atom.how.some((h) => h.toLowerCase() === term.toLowerCase()) ||
    mentions(`${atom.what}\n${atom.sourceQuote}`, term)
  );
}
