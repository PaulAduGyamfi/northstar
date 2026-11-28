import type { JobFields } from "@northstar/db";

// The exact text a job is embedded from (NS-129, ADR-0033 item 2): its title, company and
// requirements lines, all from the employer's own posting, one per line. Never the description's
// other text, a URL, pay or anything of Paul's. Any new field needs ADR-0033 amended.

// A line that holds a link or an address is dropped, never sent (ADR-0033 item 2: never a URL).
const LINKISH = /:\/\/|www\.|@/i;

// The longest text sent for one job (the client's own limit is higher).
export const MAX_EMBEDDING_TEXT = 4_000;

// Null when the job lacks a title or company: two jobs can't be compared without them.
export function embeddingText(
  job: Pick<JobFields, "title" | "company" | "requirements">,
): string | null {
  const title = job.title?.trim();
  const company = job.company?.trim();
  if (!title || !company) return null;
  const lines = [title, company, ...job.requirements.map((r) => r.trim())]
    .filter(Boolean)
    .filter((line) => !LINKISH.test(line));
  // A title or company that is itself a link isn't comparable either.
  if (lines[0] !== title || lines[1] !== company) return null;
  // Whole lines only, so a cut never leaves half a requirement.
  let text = "";
  for (const line of lines) {
    const next = text === "" ? line : `${text}\n${line}`;
    if (next.length > MAX_EMBEDDING_TEXT) break;
    text = next;
  }
  // The title and company must both fit, or there is nothing to compare.
  return text.split("\n").length >= 2 ? text : null;
}
