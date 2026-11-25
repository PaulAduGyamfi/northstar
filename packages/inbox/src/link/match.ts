import type { MessageHeaders } from "../gmail.js";
import { ATS_DOMAINS, authenticatedDomains, underDomain } from "../prefilter.js";
import { isVerificationMail } from "../verify/detect.js";
import { tagFromDeliveredTo } from "./tag.js";

// Linking job mail to applications (NS-158, INB-009/011/012). Plain code, no model: the first
// step that picks exactly one application wins; anything else goes to the "confirm link" queue,
// never to a guess. P1 only links: no status ever changes from email (INB-004).

export type MatchStep = "tag" | "thread" | "sender";
export type QueueReason = "unknown_tag" | "ambiguous" | "no_match";

// A tag from mail_tag: one application, or one tenant whose applications it narrows to.
export type TagRow = { tag: string; applicationId: string | null; tenantKey: string | null };

// What matching may know about an open application.
export type LinkCandidate = {
  applicationId: string;
  tenantKey: string | null;
  // Gmail threads already linked to it deterministically.
  threadIds: readonly string[];
  // The company's own mail domains: step 3 matches only these. A shared ATS domain
  // (greenhouse.io, myworkday.com) signs mail for every company on that ATS, so it never picks
  // an application by itself.
  companyDomains: readonly string[];
  // ATS sender domains for this application: they count toward senderVerified only.
  atsDomains: readonly string[];
  // When mail about it can arrive: from when it was started to when it closed (null: open).
  activeFrom: Date;
  activeUntil: Date | null;
};

export type MatchResult =
  // The Verification Catcher owns this message (INB-012): never linked, queued or stored here.
  | { kind: "skip"; reason: "verification" }
  // senderVerified: an authenticated domain (DMARC or DKIM pass) is under the application's
  // company or ATS domains. Only such a link may ever drive a status change (INB-011, P2).
  | { kind: "linked"; applicationId: string; step: MatchStep; senderVerified: boolean }
  | { kind: "queued"; reason: QueueReason; candidateIds: string[] };

// Shared mail domains: a DMARC or DKIM pass for one of these says nothing about which company
// wrote the mail, so they never count as a company's own domain, whatever a caller passes.
const SHARED_DOMAINS: readonly string[] = [
  ...ATS_DOMAINS,
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
];

// The domains that vouch for this message's From (INB-011): a DMARC pass, or a DKIM pass whose
// signing domain is the From domain or a parent of it (relaxed alignment, one direction only).
// Any DKIM signature passes for its own domain, so an unaligned one (a shared ATS signing
// someone else's From) proves nothing. A signer under the From domain doesn't count either:
// with a bare-suffix From (`x@co.uk`) every signer would be "under" it.
function verifiedDomains(mail: MessageHeaders): string[] {
  const from = mail.senderDomain.toLowerCase();
  if (from === "") return [];
  return authenticatedDomains(mail.authenticationResults).filter((d) => underDomain(from, d));
}

// A candidate's own company domains: never a shared ATS or freemail domain, nor one under it.
const ownDomains = (c: LinkCandidate) =>
  c.companyDomains
    .map((d) => d.toLowerCase())
    .filter((d) => !SHARED_DOMAINS.some((shared) => underDomain(d, shared)));

const inWindow = (c: LinkCandidate, at: Date) =>
  c.activeFrom.getTime() <= at.getTime() &&
  (c.activeUntil === null || at.getTime() <= c.activeUntil.getTime());

const underAny = (verified: readonly string[], roots: readonly string[]) =>
  verified.some((v) => roots.some((r) => underDomain(v, r.toLowerCase())));

export function matchMail(
  mail: MessageHeaders,
  tags: readonly TagRow[],
  candidates: readonly LinkCandidate[],
): MatchResult {
  if (isVerificationMail(mail)) return { kind: "skip", reason: "verification" };
  const verified = verifiedDomains(mail);
  const linked = (c: LinkCandidate, step: MatchStep): MatchResult => ({
    kind: "linked",
    applicationId: c.applicationId,
    step,
    senderVerified: underAny(verified, [...ownDomains(c), ...c.atsDomains]),
  });

  // Step 1: the tag Gmail delivered to.
  let pool = candidates;
  const delivered = tagFromDeliveredTo(mail.deliveredTo);
  if (delivered.kind === "malformed") return queued("unknown_tag", []);
  if (delivered.kind === "tag") {
    const row = tags.find((t) => t.tag === delivered.tag);
    if (row === undefined) return queued("unknown_tag", []);
    if (row.applicationId !== null) {
      const c = candidates.find((x) => x.applicationId === row.applicationId);
      // A tag for an application that isn't open any more: Paul decides.
      return c === undefined ? queued("unknown_tag", []) : linked(c, "tag");
    }
    // A tenant tag only narrows: steps 2–3 must still pick one.
    pool = candidates.filter((c) => c.tenantKey !== null && c.tenantKey === row.tenantKey);
    if (pool.length === 0) return queued("unknown_tag", []);
  }

  // Step 2: a thread already linked to exactly one application.
  const byThread = pool.filter((c) => c.threadIds.includes(mail.threadId));
  if (byThread.length === 1 && byThread[0]) return linked(byThread[0], "thread");
  if (byThread.length > 1) return queued("ambiguous", ids(byThread));

  // Step 3: an authenticated company domain, inside the application's active window.
  const bySender = pool.filter(
    (c) => inWindow(c, mail.receivedAt) && underAny(verified, ownDomains(c)),
  );
  if (bySender.length === 1 && bySender[0]) return linked(bySender[0], "sender");
  if (bySender.length > 1) return queued("ambiguous", ids(bySender));

  // A tenant tag that steps 2–3 couldn't resolve is ambiguous among that tenant's applications.
  return delivered.kind === "tag" ? queued("ambiguous", ids(pool)) : queued("no_match", []);
}

const ids = (cs: readonly LinkCandidate[]) => cs.map((c) => c.applicationId);
const queued = (reason: QueueReason, candidateIds: string[]): MatchResult => ({
  kind: "queued",
  reason,
  candidateIds,
});
