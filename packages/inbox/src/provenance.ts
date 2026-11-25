import type { MailClassification } from "./mail-schema.js";

// Code decides (ADR-0004): every name the model extracted must appear in the email itself. Case and
// spacing may differ ("GLOBEX" in a subject); spelling may not. A failure sends the message to
// Paul's review, never into the funnel.

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export type ProvenanceFailure = { field: "company" | "role" | "requisition" };

export function checkMailProvenance(
  extracted: Pick<MailClassification, "company" | "role" | "requisition">,
  email: { from: string; subject: string; body: string },
): ProvenanceFailure[] {
  const haystack = squash(`${email.from}\n${email.subject}\n${email.body}`);
  const failures: ProvenanceFailure[] = [];
  for (const field of ["company", "role", "requisition"] as const) {
    const value = extracted[field];
    // An empty string is no name at all, so it can't count as found.
    if (value !== null && (squash(value) === "" || !haystack.includes(squash(value)))) {
      failures.push({ field });
    }
  }
  return failures;
}
