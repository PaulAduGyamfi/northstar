import { allCommon, words } from "./words.js";

// The style guide from Paul's writing samples (ANS-007, NS-136): plain measurements, no model,
// so the same samples always give the same guide. The guide feeds the answer-draft route's
// `voiceGuide` input, which sits in an untrusted block.

export type VoiceProfile = {
  samples: number;
  words: number;
  // Median words per sentence.
  sentenceWords: number;
  contractionsPer100: number;
  iPer100: number;
  wePer100: number;
  // Share of sentences ending in "!", 0 to 1, two decimals.
  exclamationShare: number;
  // Phrases of 2–4 words used in at least PHRASE_SAMPLES samples, most common first.
  phrases: string[];
};

export type MeasureResult = { ok: true; profile: VoiceProfile } | { ok: false; problem: string };

export const MIN_SAMPLES = 5;
export const MAX_SAMPLES = 10;
// A phrase is one of Paul's when he uses it in this many different samples.
export const PHRASE_SAMPLES = 3;
const MAX_PHRASES = 10;
// Writing samples are emails and posts; a cap keeps measuring quick on a wrong file.
export const MAX_SAMPLE_WORDS = 5000;

// "'s" is left out on purpose: it is as often a possessive ("Paul's") as "it is".
const CONTRACTION = /'(?:t|re|m|ve|ll|d)$/;
const round1 = (n: number) => Math.round(n * 10) / 10;
const per100 = (count: number, total: number) => round1((count / total) * 100);

// Sentences end at ".", "!" or "?" followed by a space. Known limits, which only shift the median:
// "e.g." and "Dr." split early, and lines with no end mark run together.
function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((s) => words(s).length > 0);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const middle = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? middle : Math.round(((sorted[mid - 1] ?? 0) + middle) / 2);
}

// Each sample's distinct 2–4 word phrases, within sentences only.
function samplePhrases(text: string): Set<string> {
  const found = new Set<string>();
  for (const sentence of sentences(text)) {
    const ws = words(sentence);
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= ws.length; i++) {
        const phrase = ws.slice(i, i + n);
        if (!allCommon(phrase)) found.add(phrase.join(" "));
      }
    }
  }
  return found;
}

// Phrases in enough samples, dropping any that sits inside a longer kept phrase found in as many
// samples ("walk through" inside "happy to walk through"): one habit, reported once.
function repeatedPhrases(samples: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const s of samples) {
    for (const p of samplePhrases(s)) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const kept = [...counts].filter(([, c]) => c >= PHRASE_SAMPLES);
  const longest = kept.filter(
    ([p, c]) => !kept.some(([q, d]) => q !== p && d >= c && ` ${q} `.includes(` ${p} `)),
  );
  return longest
    .sort(([p, c], [q, d]) => d - c || q.length - p.length || (p < q ? -1 : 1))
    .slice(0, MAX_PHRASES)
    .map(([p]) => p);
}

export function measureVoice(samples: readonly string[]): MeasureResult {
  if (samples.length < MIN_SAMPLES || samples.length > MAX_SAMPLES) {
    return {
      ok: false,
      problem: `need ${MIN_SAMPLES} to ${MAX_SAMPLES} writing samples, got ${samples.length}`,
    };
  }
  const empty = samples.findIndex((s) => words(s).length === 0);
  if (empty >= 0) return { ok: false, problem: `sample ${empty + 1} has no words` };
  const long = samples.findIndex((s) => words(s).length > MAX_SAMPLE_WORDS);
  if (long >= 0) {
    return { ok: false, problem: `sample ${long + 1} is longer than ${MAX_SAMPLE_WORDS} words` };
  }

  const all = samples.flatMap((s) => words(s));
  const sents = samples.flatMap((s) => sentences(s));
  return {
    ok: true,
    profile: {
      samples: samples.length,
      words: all.length,
      sentenceWords: median(sents.map((s) => words(s).length)),
      contractionsPer100: per100(all.filter((w) => CONTRACTION.test(w)).length, all.length),
      iPer100: per100(all.filter((w) => w === "i" || w.startsWith("i'")).length, all.length),
      // Contractions count too: "we're" is "we", as "I'll" is "I".
      wePer100: per100(all.filter((w) => w === "we" || w.startsWith("we'")).length, all.length),
      exclamationShare:
        Math.round((sents.filter((s) => s.endsWith("!")).length / sents.length) * 100) / 100,
      phrases: repeatedPhrases(samples),
    },
  };
}

const quoted = (phrases: readonly string[]) => phrases.map((p) => `"${p}"`).join(", ");

// The guide as short plain lines for the drafting route. Phrases to avoid are added by
// draftAnswer, the one place that also checks them.
export function renderVoiceGuide(profile: VoiceProfile): string {
  const c = profile.contractionsPer100;
  const contractions = c >= 2 ? "often" : c >= 0.5 ? "sometimes" : "rarely";
  const exclaim = profile.exclamationShare >= 0.2 ? "sometimes" : "rarely";
  const lines = [
    `Sentences: about ${profile.sentenceWords} words.`,
    `Contractions: ${contractions} (${c} per 100 words).`,
    `Says "I" ${profile.iPer100} and "we" ${profile.wePer100} times per 100 words.`,
    `Exclamation marks: ${exclaim}.`,
  ];
  if (profile.phrases.length > 0) lines.push(`Phrases they use: ${quoted(profile.phrases)}.`);
  return lines.join("\n");
}
