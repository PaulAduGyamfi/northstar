import { z } from "zod";
import { safeHref } from "./handoffs";

// Settings → Accounts (NS-198, ACC-001, ACC-008): the API's answers and the plain decisions made
// from them. Nothing here takes an email, a password or a notice's text from the list reads.

// The account statuses: a copy of ACCOUNT_STATUSES in packages/domain/src/tenant-account.ts (the
// web app doesn't depend on the domain package). A new status needs a word below in the same PR,
// or the list refuses to parse.
export const ACCOUNT_STATUSES = [
  "none",
  "creating",
  "verifying",
  "active",
  "locked",
  "needs_human",
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

// Each status in words, never colour alone (UX-020).
export const ACCOUNT_WORDS: Record<AccountStatus, string> = {
  none: "no account yet",
  creating: "creating the account",
  verifying: "waiting for the verification email",
  active: "ready",
  locked: "locked",
  needs_human: "needs your hands",
};

export const CONSENT_POLICIES = ["auto", "ask_per_tenant"] as const;
export type ConsentPolicy = (typeof CONSENT_POLICIES)[number];

// The two choices as Paul reads them (ACC-008).
export const POLICY_WORDS: Record<ConsentPolicy, string> = {
  auto: "Accept standard candidate terms and privacy notices automatically",
  ask_per_tenant: "Ask me per employer",
};
export const MARKETING_NOTE = "Marketing opt-ins are always declined, whichever you choose.";

const NOTICE_WORDS: Record<string, string> = {
  terms: "Candidate terms",
  privacy: "Privacy notice",
};

const Account = z.object({
  tenantKey: z.string(),
  ats: z.string(),
  status: z.enum(ACCOUNT_STATUSES),
  createdAt: z.string(),
  changedAt: z.string().nullable(),
});
export const AccountsBody = z.object({ items: z.array(Account) });
export type AccountView = z.infer<typeof Account>;

const Consent = z.object({
  recordId: z.string(),
  tenantKey: z.string(),
  kind: z.string(),
  noticeUrl: z.string(),
  acceptedAt: z.string(),
});
export const ConsentsBody = z.object({ items: z.array(Consent) });
export type ConsentView = z.infer<typeof Consent>;

export const PolicyBody = z.object({ policy: z.enum(CONSENT_POLICIES) });

const day = (iso: string) => iso.slice(0, 10);

// One row per tenant, built field by field: whatever else a read hands back (an email, a URL)
// never reaches the page.
export type AccountRow = {
  key: string;
  ats: string;
  status: string;
  created: string;
  changed: string;
};
export function accountRows(items: AccountView[]): AccountRow[] {
  return items.map((a) => ({
    key: a.tenantKey,
    ats: a.ats,
    status: ACCOUNT_WORDS[a.status],
    created: day(a.createdAt),
    changed: a.changedAt === null ? "never" : day(a.changedAt),
  }));
}

// One row per accepted notice: its tenant, kind in words, link and day. The link goes through
// safeHref (https only), so the page never links anything else (the API checks it too).
export type NoticeRow = {
  recordId: string;
  tenant: string;
  kind: string;
  link: string | null;
  accepted: string;
};
export function noticeRows(items: ConsentView[]): NoticeRow[] {
  return items.map((n) => ({
    recordId: n.recordId,
    tenant: n.tenantKey,
    kind: NOTICE_WORDS[n.kind] ?? "Notice",
    link: safeHref(n.noticeUrl),
    accepted: day(n.acceptedAt),
  }));
}
