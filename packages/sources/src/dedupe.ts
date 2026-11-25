import type { DedupeCandidate, JobFields, JobSourceInput } from "@northstar/db";

// One job per role (SRC-006), decided by plain code, most certain match first:
// 1. the same ATS posting id; 2. the same canonical URL; 3. the same company, title and location
// with descriptions at least SIMILARITY alike. Embeddings can join later behind this function.

export const SIMILARITY = 0.85;

// Lower case, accents and punctuation dropped, a trailing legal suffix removed.
const SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "corp",
  "corporation",
  "co",
  "plc",
  "gmbh",
]);
export function nameKey(s: string | null): string {
  if (s === null) return "";
  const words = s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words.at(-1) ?? "")) words.pop();
  return words.join(" ");
}

// Three-word shingles of a text, for comparing two descriptions.
function shingles(text: string): Set<string> {
  const words = nameKey(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= words.length; i++) out.add(words.slice(i, i + 3).join(" "));
  return out;
}

// Jaccard similarity of two descriptions' shingles: 1 for the same text, 0 for nothing shared.
export function similarity(a: string, b: string): number {
  const x = shingles(a);
  const y = shingles(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const s of x) if (y.has(s)) shared += 1;
  return shared / (x.size + y.size - shared);
}

export type Match = { jobId: string; by: "ats_posting" | "url" | "content" };

export function findDuplicate(
  existing: readonly DedupeCandidate[],
  fields: JobFields,
  source: JobSourceInput,
): Match | null {
  if (source.ats && source.atsPostingId) {
    const hit = existing.find((j) =>
      j.sources.some((s) => s.ats === source.ats && s.atsPostingId === source.atsPostingId),
    );
    if (hit) return { jobId: hit.jobId, by: "ats_posting" };
  }
  const byUrl = existing.find((j) => j.sources.some((s) => s.url === source.url));
  if (byUrl) return { jobId: byUrl.jobId, by: "url" };

  // Content: company, title and description must be present, company and title equal, and the
  // descriptions alike, so two thin postings aren't merged on a guess. Location is softer: the
  // same place is often written longer on one source ("San Francisco, CA" and "San Francisco,
  // CA, US"), so one place's words containing the other's counts. A missing location on either
  // side doesn't block a match; the description still has to agree.
  const company = nameKey(fields.company);
  const title = nameKey(fields.title);
  if (!company || !title || !fields.description) return null;
  const hit = existing.find(
    (j) =>
      nameKey(j.company) === company &&
      nameKey(j.title) === title &&
      samePlace(j.location, fields.location) &&
      j.description !== null &&
      similarity(j.description, fields.description ?? "") >= SIMILARITY,
  );
  return hit ? { jobId: hit.jobId, by: "content" } : null;
}

// Whether two locations name the same place: either is missing, or one's words all appear in the
// other's ("remote us" in "remote us united states").
export function samePlace(a: string | null, b: string | null): boolean {
  const x = nameKey(a).split(" ").filter(Boolean);
  const y = nameKey(b).split(" ").filter(Boolean);
  if (x.length === 0 || y.length === 0) return true;
  const [short, long] = x.length <= y.length ? [x, new Set(y)] : [y, new Set(x)];
  return short.every((w) => long.has(w));
}
