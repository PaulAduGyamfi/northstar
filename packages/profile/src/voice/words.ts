// Shared word handling for the voice profile (NS-136): plain code, no model.

// Words too common to say anything about how Paul writes, or to be worth avoiding on their own.
export const COMMON_WORDS = new Set(
  (
    "a about after all also am an and any are as at be been before being but by can could did " +
    "do does done for from had has have he her his how i if in into is it its just me more most " +
    "my no not now of on one or our out over she so some than that the their them then there " +
    "these they this to too up us very was we were what when where which while who why will " +
    "with would you your"
  ).split(" "),
);

// Lower-cased words, keeping apostrophes inside them ("we're", "didn't"). Look-alike letters
// (full-width, compatibility forms) read as plain ones, hidden format characters (soft hyphen,
// zero-width space) are dropped, and curly or modifier apostrophes count as straight ones, so a
// phrase can't slip past a check by its spelling.
export function words(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .replace(/\p{Cf}/gu, "")
      .toLowerCase()
      .replace(/[’ʼ]/g, "'")
      .match(/[\p{L}\p{N}]+(?:'[\p{L}]+)*/gu) ?? []
  );
}

export const allCommon = (phrase: readonly string[]): boolean =>
  phrase.every((w) => COMMON_WORDS.has(w));
