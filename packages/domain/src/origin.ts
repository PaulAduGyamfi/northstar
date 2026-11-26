// Where an application came from and how it went out (INB-007, NS-188). Each is stored as a
// domain event (the latest one wins), never edited in place (ADR-0012).

// Who started it: Northstar found the job, Paul applied without Northstar and it was found later
// from email, or a recruiter started it.
export const STARTED_BY = ["northstar", "outside", "recruiter_inbound"] as const;
export type StartedBy = (typeof STARTED_BY)[number];

// How it went out: an auto-approve policy, Paul's approval, Paul finishing a step by hand, or
// Paul applying outside Northstar.
export const SUBMITTED_VIA = ["auto", "approved", "handoff", "by_hand"] as const;
export type SubmittedVia = (typeof SUBMITTED_VIA)[number];

export const isStartedBy = (v: unknown): v is StartedBy =>
  typeof v === "string" && (STARTED_BY as readonly string[]).includes(v);
export const isSubmittedVia = (v: unknown): v is SubmittedVia =>
  typeof v === "string" && (SUBMITTED_VIA as readonly string[]).includes(v);

// The credit report's buckets (INB-010): "started by Northstar" means started_by northstar and
// not submitted by hand.
export type OriginBucket =
  | "northstar"
  | "northstar_by_hand"
  | "outside"
  | "recruiter_inbound"
  | "unknown";

export function originBucket(
  startedBy: StartedBy | null,
  submittedVia: SubmittedVia | null,
): OriginBucket {
  if (startedBy === null) return "unknown";
  if (startedBy === "northstar")
    return submittedVia === "by_hand" ? "northstar_by_hand" : "northstar";
  return startedBy;
}
