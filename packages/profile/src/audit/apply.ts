import { mentions } from "../tailor/terms.js";
import type { MasterResume, MasterRole } from "../tailor/types.js";
import { normalize } from "../validate.js";
import type { Suggestion } from "./audit.js";

// Accepting a suggestion (NS-159, AUD-002): Paul writes the new line himself, and this returns a
// new master in which only that atom's resume line changed. Plain code. Roles, dates, skills and
// every other atom stay exactly as they were, and locked facts (employers, titles, dates; CPG-004)
// are never edited here: a line that names another role's employer, title or dates is refused, so
// an edit can't move a claim from one job to another. Storing the result is the caller's job.

export type ApplyRefusal =
  // The suggestion is about a role, a target term or the whole resume, not one line.
  | "not_a_line"
  | "unknown_atom"
  | "empty"
  // A line break or control character could start a fake header when rendered.
  | "multi_line"
  | "names_other_role";

export type ApplyResult = { ok: true; master: MasterResume } | { ok: false; reason: ApplyRefusal };

// Bullet markers the rendered resume adds itself.
const BULLET = /^[\s•·▪◦‣*-]+/;

// The calendar years a role spans: start to end, open-ended while it is current. A role with no
// start date spans nothing (its dates are missing, and the audit says so).
type Span = { from: number; to: number };
function span(role: MasterRole): Span | null {
  if (role.startMonth === null) return null;
  const from = Number(role.startMonth.slice(0, 4));
  if (role.isCurrent || role.endMonth === null)
    return { from, to: role.isCurrent ? Infinity : from };
  return { from, to: Number(role.endMonth.slice(0, 4)) };
}
const inSpan = (year: number, s: Span | null) => s !== null && year >= s.from && year <= s.to;

// Four-digit years written in the line, as whole numbers.
const yearsIn = (line: string) =>
  (line.match(/(?<![0-9])(?:19|20)[0-9]{2}(?![0-9])/g) ?? []).map(Number);

// True when the line names an employer, title or year of a role other than `own`, unless `own`
// shares it: an employer or title inside its own, or a year inside its own span. A year inside
// another role's span and outside its own would move a claim to another job's period (CPG-004).
function namesOtherRole(line: string, own: MasterRole | undefined, roles: MasterRole[]): boolean {
  const ownSpan = own === undefined ? null : span(own);
  const years = yearsIn(line).filter((y) => !inSpan(y, ownSpan));
  return roles
    .filter((r) => r.id !== own?.id)
    .some(
      (r) =>
        (mentions(line, r.employer) && !(own && mentions(own.employer, r.employer))) ||
        (mentions(line, r.title) && !(own && mentions(own.title, r.title))) ||
        years.some((y) => inSpan(y, span(r))),
    );
}

export function applySuggestion(
  master: MasterResume,
  suggestion: Suggestion,
  newLine: string,
): ApplyResult {
  if (!("atomId" in suggestion.target)) return { ok: false, reason: "not_a_line" };
  const atomId = suggestion.target.atomId;
  const atom = master.atoms.find((a) => a.id === atomId);
  if (atom === undefined) return { ok: false, reason: "unknown_atom" };
  // Checked before normalising, which would turn a line break into a space.
  if (/\p{Cc}/u.test(newLine)) return { ok: false, reason: "multi_line" };
  const text = normalize(newLine);
  if (text.replace(BULLET, "") === "") return { ok: false, reason: "empty" };
  const own = master.roles.find((r) => r.id === atom.roleId);
  if (namesOtherRole(text, own, master.roles)) return { ok: false, reason: "names_other_role" };
  return {
    ok: true,
    master: {
      ...master,
      atoms: master.atoms.map((a) => (a.id === atomId ? { ...a, sourceQuote: text } : a)),
    },
  };
}
