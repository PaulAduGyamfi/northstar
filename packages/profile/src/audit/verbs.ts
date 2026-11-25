// Word lists for the resume audit (NS-159, AUD-001). Plain code: the lists err toward fewer
// suggestions, so a verb they don't know counts as an action verb and is never called the wrong
// tense.

// Openers that describe being near the work rather than doing it. Longest first, so "worked on"
// wins over a shorter match. Lower case, matched at the start of the line.
export const WEAK_OPENERS = [
  "was responsible for",
  "responsible for",
  "duties included",
  "worked on",
  "working on",
  "involved in",
  "tasked with",
  "helped",
  "helping",
  "helps",
  "help",
  "assisted",
  "assisting",
  "assists",
  "assist",
  "participated",
  "participating",
].sort((a, b) => b.length - a.length);

// Action verbs whose present forms ("Build", "Builds", "Building") are flagged in a past role.
// Left out: verbs whose past form is the same as the base (cut, set, put, read), since "Cut costs"
// is fine in a past role, and verbs that open a line as a noun just as often (lead, design, test,
// support, plan, monitor, document, scale, drive, coach, fix): "Design system migration" isn't
// present tense.
const VERBS =
  "build manage develop write run own create maintain deliver implement migrate launch improve " +
  "reduce ship mentor architect automate define establish grow coordinate oversee deploy " +
  "operate analyze optimize refactor standardize hire train negotiate integrate redesign " +
  "rebuild streamline";

// Verbs that double their last consonant before -ing (run → running).
const DOUBLING = new Set(["run", "ship"]);

function thirdPerson(v: string): string {
  if (/(s|x|z|ch|sh)$/.test(v)) return `${v}es`;
  if (/[^aeiou]y$/.test(v)) return `${v.slice(0, -1)}ies`;
  return `${v}s`;
}

function participle(v: string): string {
  if (DOUBLING.has(v)) return `${v}${v.slice(-1)}ing`;
  if (/[^e]e$/.test(v)) return `${v.slice(0, -1)}ing`;
  return `${v}ing`;
}

// Every present form of every listed verb, lower case.
export const PRESENT_FORMS: ReadonlySet<string> = new Set(
  VERBS.split(" ").flatMap((v) => [v, thirdPerson(v), participle(v)]),
);
