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
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![${NAME_CHAR}])${escaped}(?![${NAME_CHAR}])`, "i").test(text);
}

export type Match = { requirement: string; kind: "must" | "nice"; atomId: string; term: string };
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
