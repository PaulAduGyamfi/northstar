// Confirmations from the standard ATS subject lines, classified by plain code with no model call.
// A rule only answers when it can also read the company from the subject; anything else is left to
// the mail-classify route. Company and role come from the subject verbatim, so they pass the
// provenance check by construction.

export type RuleResult = { kind: "confirmation"; company: string; role: string | null };

// "Thank you for applying for the Backend Engineer role at Globex"
const ROLE_AT =
  /^(?:thank you|thanks) for applying for (?:the )?(.+?) (?:role|position) at (.+?)[.!]?$/i;
// "Thank you for applying to Globex!" / "Thanks for applying at Globex"
const APPLYING_TO = /^(?:thank you|thanks) for applying (?:to|at|with) (.+?)[.!]?$/i;
// "Your application to Acme Corp has been received"
const RECEIVED = /^your application (?:to|at|with) (.+?) has been (?:received|submitted)[.!]?$/i;

export function classifyByRules(headers: { subject: string }): RuleResult | null {
  const subject = headers.subject.trim();
  const roleAt = ROLE_AT.exec(subject);
  if (roleAt?.[1] && roleAt[2]) {
    return { kind: "confirmation", company: roleAt[2].trim(), role: roleAt[1].trim() };
  }
  const company = APPLYING_TO.exec(subject)?.[1] ?? RECEIVED.exec(subject)?.[1];
  if (company) return { kind: "confirmation", company: company.trim(), role: null };
  return null;
}
