import { allCommon, COMMON_WORDS, words } from "./words.js";

// Learning from Paul's edits (ANS-008, NS-136): plain code over each draft and the text he
// approved. A phrase he deletes from AVOID_AFTER different drafts is avoided from then on, and a
// draft that still contains one never reaches him (draftAnswer).

export type Edit = { draft: string; approved: string };

export const AVOID_AFTER = 3;
// A longer removed run (after trimming common words) is a rewrite, not a phrase he dislikes.
const MAX_PHRASE_WORDS = 4;
// Answers are short. The word diff is quadratic, so an edit longer than this on either side is
// skipped rather than diffed.
export const MAX_EDIT_WORDS = 2000;

// Words of `a` that are also in `b` in order (a longest common subsequence), so moved or kept
// words aren't counted as deleted.
function keptMask(a: readonly string[], b: readonly string[]): boolean[] {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = table[i] as number[];
      row[j] =
        a[i] === b[j]
          ? ((table[i + 1] as number[])[j + 1] ?? 0) + 1
          : Math.max((table[i + 1] as number[])[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const kept = new Array<boolean>(a.length).fill(false);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      kept[i] = true;
      i++;
      j++;
    } else if (((table[i + 1] as number[])[j] ?? 0) >= ((table[i] as number[])[j + 1] ?? 0)) {
      i++;
    } else {
      j++;
    }
  }
  return kept;
}

// Each run of draft words missing from the approved text, with common words trimmed from its
// ends ("to leverage our synergies" → "leverage our synergies"). Runs of only common words, and
// trimmed runs longer than four words, are left out. Runs may span a sentence end.
export function deletedPhrases(draft: string, approved: string): string[] {
  const a = words(draft);
  const b = words(approved);
  if (a.length > MAX_EDIT_WORDS || b.length > MAX_EDIT_WORDS) return [];
  const kept = keptMask(a, b);
  const runs: string[][] = [];
  let run: string[] = [];
  a.forEach((w, i) => {
    if (kept[i]) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else run.push(w);
  });
  if (run.length > 0) runs.push(run);
  const out: string[] = [];
  for (const r of runs) {
    let start = 0;
    let end = r.length;
    while (start < end && COMMON_WORDS.has(r[start] as string)) start++;
    while (end > start && COMMON_WORDS.has(r[end - 1] as string)) end--;
    const phrase = r.slice(start, end);
    if (phrase.length === 0 || phrase.length > MAX_PHRASE_WORDS) continue;
    if (!out.includes(phrase.join(" "))) out.push(phrase.join(" "));
  }
  return out;
}

// Every part of a deleted phrase that isn't only common words: "leverage" cut as "leverage the
// data" one day and "leverage" the next is the same habit (ANS-008's own example).
function phraseParts(phrase: string): string[] {
  const ws = phrase.split(" ");
  const parts: string[] = [];
  for (let n = 1; n <= ws.length; n++) {
    for (let i = 0; i + n <= ws.length; i++) {
      const part = ws.slice(i, i + n);
      if (!allCommon(part)) parts.push(part.join(" "));
    }
  }
  return parts;
}

// Phrases deleted in at least `threshold` different drafts (ANS-008). A phrase inside a longer
// one deleted as often is reported once, as the longer one ("leverage our" over "leverage" when
// both were cut three times). Order: most drafts first, then longer, then alphabetical.
export function avoidedPhrases(edits: readonly Edit[], threshold = AVOID_AFTER): string[] {
  return avoidedFromDeleted(
    edits.map((e) => deletedPhrases(e.draft, e.approved)),
    threshold,
  );
}

// The same, over each draft's deleted phrases as stored (NS-185: only the deleted phrases are
// kept, never the draft or the approved text).
export function avoidedFromDeleted(
  deletedPerDraft: readonly (readonly string[])[],
  threshold = AVOID_AFTER,
): string[] {
  const counts = new Map<string, number>();
  for (const deleted of deletedPerDraft) {
    // A set per draft: deleting a phrase twice in one draft counts once.
    const parts = new Set(deleted.flatMap(phraseParts));
    for (const p of parts) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const kept = [...counts].filter(([, c]) => c >= threshold);
  return kept
    .filter(([p, c]) => !kept.some(([q, d]) => q !== p && d >= c && ` ${q} `.includes(` ${p} `)))
    .sort(([p, c], [q, d]) => d - c || q.length - p.length || (p < q ? -1 : 1))
    .map(([p]) => p);
}

// The positions (in `avoid`) of the avoided phrases a text contains, matched as whole words, so
// a failure can name a phrase without repeating the text. Matching ignores punctuation, so a
// phrase split across two sentences still counts: that errs toward Paul's review.
export function findAvoided(text: string, avoid: readonly string[]): number[] {
  const t = ` ${words(text).join(" ")} `;
  return avoid.flatMap((p, i) => {
    const phrase = words(p).join(" ");
    return phrase !== "" && t.includes(` ${phrase} `) ? [i] : [];
  });
}
