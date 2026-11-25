// What counts as a name in a story part or an answer sentence (NS-202): an employer, tool, person
// or place the text would add, which must then be backed by its sources. Plain code. A word that
// starts with a capital always counted (NS-111, NS-135). Since NS-202 a word also counts when it
// is mixed case ("iOS", "eBay") or starts with a digit and holds a capital ("3M"), and each piece
// of a hyphen- or slash-joined word is looked at on its own ("ex-Globex", "planner/Globex").
//
// All-lowercase names ("globex", "npm") can't be told from ordinary words without a vocabulary of
// known names, so they are not caught here (a dictionary would refuse ordinary words instead).

// A capital first, a capital right after a lower-case letter, or a digit first with a capital
// somewhere after it. Units and numbers ("10k", "24h", "12%") have no capital, so they never count.
const NAME_SHAPE = /^\p{Lu}|\p{Ll}\p{Lu}|^\p{N}[\p{L}\p{N}]*\p{Lu}/u;

// "I" and its contractions ("I've", "I’m") are Paul, never a name.
const PAUL = /^I(?:['’]\p{L}+)?$/u;

// The name candidates in one word, in order. The word comes with its edge punctuation and
// possessive already removed by the caller.
export function nameParts(word: string): string[] {
  if (PAUL.test(word)) return [];
  return word
    .split(/[-/]/)
    .filter((part) => part !== "" && !PAUL.test(part) && NAME_SHAPE.test(part));
}
