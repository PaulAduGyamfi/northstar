import type { MAIL_KINDS } from "../mail-schema.js";

// The Gmail label names Northstar may put on a thread (NS-229, INB-005, INB-008, ADR-0027). Plain
// code: names come only from these fixed tables, never from mail text or model output, so the
// label writer can refuse anything else.

export type MailKind = (typeof MAIL_KINDS)[number];

// The origin bucket of the thread's application. The same values as @northstar/domain's
// OriginBucket (INB-010); this package doesn't depend on the domain.
export type LabelOrigin =
  | "northstar"
  | "northstar_by_hand"
  | "outside"
  | "recruiter_inbound"
  | "unknown";

// INB-005's type labels. Interview requests and scheduling share one label: both are about
// getting an interview on the calendar. info_other gets none.
const TYPE_LABELS: Readonly<Record<MailKind, string | null>> = {
  confirmation: "Northstar/Confirmation",
  rejection: "Northstar/Rejection",
  assessment: "Northstar/Assessment",
  interview_request: "Northstar/Interview",
  scheduling: "Northstar/Interview",
  recruiter_inbound: "Northstar/Recruiter",
  follow_up_needed: "Northstar/Follow-up",
  offer: "Northstar/Offer",
  info_other: null,
};

// INB-008's origin labels. An application started by Northstar but submitted by hand is still
// Northstar's; a recruiter's approach is outside. Unknown origin gets none rather than a guess.
const ORIGIN_LABELS: Readonly<Record<LabelOrigin, string | null>> = {
  northstar: "Northstar/Started-by-Northstar",
  northstar_by_hand: "Northstar/Started-by-Northstar",
  outside: "Northstar/Outside",
  recruiter_inbound: "Northstar/Outside",
  unknown: null,
};

// Every name the writer may create or apply.
export const LABEL_NAMES: ReadonlySet<string> = new Set(
  [...Object.values(TYPE_LABELS), ...Object.values(ORIGIN_LABELS)].filter(
    (n): n is string => n !== null,
  ),
);

// A thread's labels: its type label (once it is classified) and its origin label, without
// duplicates. An empty list means nothing to apply.
export function threadLabels(kind: MailKind | null, origin: LabelOrigin): string[] {
  const names = [kind === null ? null : TYPE_LABELS[kind], ORIGIN_LABELS[origin]];
  return [...new Set(names.filter((n): n is string => n !== null))];
}
