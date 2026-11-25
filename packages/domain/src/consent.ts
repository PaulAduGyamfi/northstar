// The consent policy (NS-124, ACC-008): one setting Paul chooses once. packages/db copies both
// lists into CHECK constraints.

// `auto` (the default): accept standard candidate terms and privacy notices. `ask_per_tenant`:
// ask Paul each time.
export const CONSENT_POLICIES = ["auto", "ask_per_tenant"] as const;
export type ConsentPolicy = (typeof CONSENT_POLICIES)[number];
export const DEFAULT_CONSENT_POLICY: ConsentPolicy = "auto";

export const NOTICE_KINDS = ["terms", "privacy", "marketing"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export type ConsentDecision = "accept" | "decline" | "ask";

export function decideConsent(policy: ConsentPolicy, kind: NoticeKind): ConsentDecision {
  // Marketing opt-ins are always declined, whatever the policy (ACC-008).
  if (kind === "marketing") return "decline";
  return policy === "auto" ? "accept" : "ask";
}
