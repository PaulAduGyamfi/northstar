import type { Route } from "@northstar/llm";
import { untrustedBlock } from "@northstar/llm";
import { loadPrompt } from "@northstar/prompts";
import { MailClassification } from "./mail-schema.js";

export const MAIL_CLASSIFY_VERSION = 1;

// Bodies are cut here: the first part of a job email says what it is, and a long thread would
// cost tokens for nothing.
export const BODY_LIMIT = 6_000;

export type MailClassifyInput = { from: string; subject: string; date: string; body: string };

// The email as the route sees it: headers, then the body up to BODY_LIMIT characters.
export function renderEmail(input: MailClassifyInput): string {
  const body =
    input.body.length > BODY_LIMIT ? `${input.body.slice(0, BODY_LIMIT)}\n[cut]` : input.body;
  return `from: ${input.from}\nsubject: ${input.subject}\ndate: ${input.date}\n\n${body}`;
}

// The mail-classify route (NS-113): one job email in, its type, employer, role and stage out. The
// email is untrusted text (NFR-SEC-004) and the route has no tools.
export function mailClassifyRoute(): Route<MailClassifyInput, MailClassification> {
  const prompt = loadPrompt("mail-classify", MAIL_CLASSIFY_VERSION);
  return {
    name: "mail-classify",
    prompt,
    // Sorting one short email with copy-exact extraction: low effort; the eval set is the check
    // (ADR-0006). Raise it only with an eval result that shows the gain.
    effort: "low",
    maxTokens: 1_000,
    timeoutMs: 60_000,
    // Bulk backfill work that can wait a day: the first to pause at the spend cap (ADR-0021).
    priority: "low",
    output: MailClassification,
    render: (input) => ({ stable: [], volatile: untrustedBlock("email", renderEmail(input)) }),
  };
}
