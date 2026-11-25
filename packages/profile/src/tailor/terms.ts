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

// True when the atom's own text (`what`, `how` or resume line) names the term.
export function atomNames(atom: MasterAtom, term: string): boolean {
  return (
    atom.how.some((h) => h.toLowerCase() === term.toLowerCase()) ||
    mentions(`${atom.what}\n${atom.sourceQuote}`, term)
  );
}
