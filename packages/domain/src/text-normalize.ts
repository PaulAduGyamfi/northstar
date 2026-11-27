// Typography only: curly quotes, dash variants, non-breaking spaces and line breaks (a bullet that
// wraps). Words, digits and punctuation that carry meaning are compared exactly. Moved here from
// packages/profile (NS-249) with the question matcher that uses it; profile re-exports it.
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}
