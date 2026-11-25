import type { ScoringProfile } from "@northstar/db";

// Requirement → experience atom matching by rule (NS-116, MAT-002). Plain code, no model: a
// requirement is met by an atom when a technology the atom names appears in the requirement.

// Characters that continue a technology name: "Go" isn't in "Google", "C" isn't in "C#" or "C++".
const NAME_CHAR = "A-Za-z0-9+#";

// True when `term` appears in `text` as a whole name, ignoring case. A term ending in a dot
// ("Node.js") still needs a non-name character after it.
export function namesTerm(text: string, term: string): boolean {
  const t = term.trim();
  if (t === "") return false;
  return patternFor(t).test(text);
}

// Each term's pattern is compiled once: a pass tests every requirement against every term.
// Terms come from Paul's resume and preferences (bounded), never from postings, so this stays
// small; it is cleared past 5,000 entries all the same.
const PATTERNS = new Map<string, RegExp>();
function patternFor(term: string): RegExp {
  let p = PATTERNS.get(term);
  if (!p) {
    if (PATTERNS.size >= 5_000) PATTERNS.clear();
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // No `g` flag: test() then keeps no state between calls.
    p = new RegExp(`(?<![${NAME_CHAR}])${escaped}(?![${NAME_CHAR}])`, "i");
    PATTERNS.set(term, p);
  }
  return p;
}

// `term` is the technology the rules found, or, for a model match (NS-138, `by: "model"`), the
// verbatim quote from the atom that checkJobMatches accepted.
export type Match = {
  requirement: string;
  kind: "must" | "nice";
  atomId: string;
  term: string;
  by?: "model";
  // For a model match: the prompt version and model that proposed it.
  stamp?: string;
};
export type Unmatched = { requirement: string; kind: "must" | "nice" };

// The terms an atom stands for: its `how` list, plus the resume's skills its own text names
// ("Built the billing service in Go" stands for Go when Go is a listed skill).
function atomTerms(profile: ScoringProfile): { atomId: string; terms: string[] }[] {
  return profile.atoms.map((a) => ({
    atomId: a.id,
    terms: [...a.how, ...profile.skills.filter((s) => namesTerm(a.what, s))],
  }));
}

// Each requirement with the first atom (resume order) whose terms it names, or unmatched.
export function matchRequirements(
  requirements: { text: string; kind: "must" | "nice" }[],
  profile: ScoringProfile,
): { matched: Match[]; unmatched: Unmatched[] } {
  const atoms = atomTerms(profile);
  const matched: Match[] = [];
  const unmatched: Unmatched[] = [];
  for (const { text, kind } of requirements) {
    let hit: Match | null = null;
    for (const a of atoms) {
      const term = a.terms.find((t) => namesTerm(text, t));
      if (term) {
        hit = { requirement: text, kind, atomId: a.atomId, term };
        break;
      }
    }
    if (hit) matched.push(hit);
    else unmatched.push({ requirement: text, kind });
  }
  return { matched, unmatched };
}
