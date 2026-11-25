// What an answer draft may rest on (ANS-004, NS-135): Paul's approved stories and his resume
// atoms, as plain text with their ids. Retrieval is plain code over words; embeddings are NS-137's
// decision. Reading the stories and atoms from the database is the caller's job.

export type EvidenceItem = {
  id: string;
  kind: "story" | "atom";
  // A story: its title and its four STAR parts. An atom: its resume line. What the route shows.
  text: string;
  // What quotes and names are checked against, when it differs from `text` (NS-202): a story's
  // four parts without its title, because titles are never name-checked.
  checkText?: string;
};

// The story's text as the route and the validator see it: its title, then each part in order.
export function storyEvidence(story: {
  id: string;
  title: string;
  situation: string;
  task: string;
  action: string;
  result: string;
}): EvidenceItem {
  const sentence = (part: string) => part.trim().replace(/[.!?]?$/, ".");
  const parts = [story.situation, story.task, story.action, story.result].map(sentence);
  const text = [sentence(story.title), ...parts].join(" ");
  return { id: story.id, kind: "story", text, checkText: parts.join(" ") };
}

export function atomEvidence(atom: { id: string; sourceQuote: string }): EvidenceItem {
  return { id: atom.id, kind: "atom", text: atom.sourceQuote };
}

// Words too common to say what a question is about.
const STOP_WORDS = new Set(
  (
    "a about after all an and any are as at be been before but by can could describe did do " +
    "does example for from had has have how i if in into is it its me more most my not of on " +
    "one or our out over please share so some tell than that the their them then there these " +
    "they this time to us was we were what when where which while who why will with would you " +
    "your"
  ).split(" "),
);

// Lower-case content words, with a plural "s" dropped so "deadlines" meets "deadline".
export function contentWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(
    words
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
      .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)),
  );
}

export const EVIDENCE_LIMIT = 6;

// The items sharing the most content words with the question, best first; only items that
// share at least one. Ties: stories before atoms (a story tells more), then by id, so the
// same inputs always give the same evidence and the same request.
export function selectEvidence(
  question: string,
  items: readonly EvidenceItem[],
  limit = EVIDENCE_LIMIT,
): EvidenceItem[] {
  const asked = contentWords(question);
  return items
    .map((item) => {
      const words = contentWords(item.text);
      return { item, score: [...asked].filter((w) => words.has(w)).length };
    })
    .filter((s) => s.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.item.kind === b.item.kind ? 0 : a.item.kind === "story" ? -1 : 1) ||
        // Code-point order, not the locale's, so every machine sends the same request.
        (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
    )
    .slice(0, limit)
    .map((s) => s.item);
}
