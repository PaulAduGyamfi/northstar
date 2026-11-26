import { hasWhole } from "./validate.js";

// What counts as a name in a story part or an answer sentence (NS-202): an employer, tool, person
// or place the text would add, which must then be backed by its sources. Plain code. A word that
// starts with a capital always counted (NS-111, NS-135). Since NS-202 a word is cut into pieces at
// every character that can't be part of a name, and each piece holding a capital is a name:
// "iOS", "eBay", "2FA", "ex-Globex", "planner/Globex", "l'Oréal", "x.AI", and words joined by an
// invisible character (a soft hyphen or a zero-width space), which would otherwise hide a name.
//
// All-lowercase names ("globex", "npm") can't be told from ordinary words without a vocabulary of
// known names, so they are not caught here (a dictionary would refuse ordinary words instead).

// Characters a name is made of: letters, digits, and + and # (C++, C#). Every other character,
// visible or not, joins two pieces.
const JOINER = /[^\p{L}\p{N}+#]+/u;

// A piece with a capital anywhere is a name. Units and numbers ("10k", "24h", "12%") have none.
const HAS_CAPITAL = /\p{Lu}/u;

// A number with a unit written with a capital ("1M", "5GB", "200kW") is a quantity, not a name
// (NS-216, Paul's decision on #203). Its digits still face the number rule, and its scale must be
// in the same sources (unbackedUnits below), so "5 thousand" can't become "5B". ASCII digits
// only: NFKC has already folded fullwidth digits, and digits from other scripts are no number the
// number rule sees. "3M" the company has the same shape and is exempt too, but needs "3M" or "million" backed. Units not on the list
// ("2FA", "5G") stay names.
const UNIT = /^[0-9]+(K|M|B|KB|MB|GB|TB|PB|kW|MW|GW|dB|Hz|kHz|MHz|GHz)$/u;

// The words that state K, M and B's scale. Single letters aren't listed: "m" is also the end of
// "I'm". A digit right before the letter ("1m", "5 k") counts on its own (unitBacked).
const SCALE_WORDS: Record<string, readonly string[]> = {
  K: ["thousand", "thousands"],
  M: ["million", "millions", "mn"],
  B: ["billion", "billions", "bn"],
};

// The unit of a number-plus-unit piece ("5GB" → "GB"), or null.
export function unitOf(piece: string): string | null {
  return UNIT.exec(piece)?.[1] ?? null;
}

// True when `sources` (normalised) state the unit's scale: the unit right after a number ("1M",
// "5 GB", any case), or for K, M and B its word ("million").
export function unitBacked(unit: string, sources: string): boolean {
  const lower = sources.toLowerCase();
  const u = unit.toLowerCase();
  if (new RegExp(`[0-9] ?${u}(?![\\p{L}\\p{N}])`, "u").test(lower)) return true;
  return (SCALE_WORDS[unit] ?? []).some((w) => hasWhole(lower, w));
}

// Positions of words in `text` (normalised) holding a number-plus-unit whose scale `sources`
// don't state. Positions, never words: the text is Paul's material or a draft of it.
export function unbackedUnits(text: string, sources: string): number[] {
  const out: number[] = [];
  text.split(" ").forEach((raw, position) => {
    const pieces = raw.split(JOINER).filter((p) => p !== "");
    if (
      pieces.some((p) => {
        const u = unitOf(p);
        return u !== null && !unitBacked(u, sources);
      })
    ) {
      out.push(position);
    }
  });
  return out;
}

// "I" and its real contractions are Paul, never a name. Only these: "I'Globex" is not Paul.
const PAUL = /^I(?:['’](?:m|ve|d|ll))?$/u;

// The name candidates in one word, in order. The word comes with its edge punctuation and
// possessive already removed by the caller.
export function nameParts(word: string): string[] {
  if (PAUL.test(word)) return [];
  return word
    .split(JOINER)
    .filter((part) => part !== "" && part !== "I" && HAS_CAPITAL.test(part) && !UNIT.test(part));
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
    // Grammar only capitalises a first letter: "iOS" or "2FA" opening a sentence is no opener.
    leading: i === 0 && word.startsWith(name) && /^\p{Lu}/u.test(name),
  }));
  // A piece that is the whole word is checked once, as the whole word when that was added.
  return [...whole, ...pieces.filter((p) => whole.length === 0 || p.name !== word)];
}
