// What counts as a name in a story part or an answer sentence (NS-202): an employer, tool, person
// or place the text would add, which must then be backed by its sources. Plain code. A word that
// starts with a capital always counted (NS-111, NS-135). Since NS-202 a word is cut into pieces at
// every character that can't be part of a name, and each piece holding a capital is a name:
// "iOS", "eBay", "3M", "ex-Globex", "planner/Globex", "l'Oréal", "x.AI", and words joined by an
// invisible character (a soft hyphen or a zero-width space), which would otherwise hide a name.
//
// All-lowercase names ("globex", "npm") can't be told from ordinary words without a vocabulary of
// known names, so they are not caught here (a dictionary would refuse ordinary words instead).

// Characters a name is made of: letters, digits, and + and # (C++, C#). Every other character,
// visible or not, joins two pieces.
const JOINER = /[^\p{L}\p{N}+#]+/u;

// A piece with a capital anywhere is a name. Units and numbers ("10k", "24h", "12%") have none.
const HAS_CAPITAL = /\p{Lu}/u;

// "I" and its real contractions are Paul, never a name. Only these: "I'Globex" is not Paul.
const PAUL = /^I(?:['’](?:m|ve|d|ll))?$/u;

// The name candidates in one word, in order. The word comes with its edge punctuation and
// possessive already removed by the caller.
export function nameParts(word: string): string[] {
  if (PAUL.test(word)) return [];
  return word.split(JOINER).filter((part) => part !== "" && part !== "I" && HAS_CAPITAL.test(part));
}

// Everything one word must have backed, in order. A word that starts with a capital must still be
// backed whole, as before NS-202, so a made-up compound of two real names ("Globex-Initech" when
// the sources only say "Globex" and "Initech") stays refused; then each of its name pieces.
// `leading` marks the candidates that start the word (the whole word and its first piece): only
// those can be a sentence's grammatical capital.
export type NameCandidate = { name: string; leading: boolean };

export function nameCandidates(word: string): NameCandidate[] {
  if (PAUL.test(word)) return [];
  const whole = /^\p{Lu}/u.test(word) ? [{ name: word, leading: true }] : [];
  const pieces = nameParts(word).map((name, i) => ({
    name,
    leading: i === 0 && word.startsWith(name),
  }));
  // A piece that is the whole word is checked once, as the whole word when that was added.
  return [...whole, ...pieces.filter((p) => whole.length === 0 || p.name !== word)];
}
