import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { MessageHeaders } from "../gmail.js";
import { type VerificationWindow, windowMatches } from "../verify/catcher.js";
import { hasVerificationSubject } from "../verify/detect.js";
import { type LinkCandidate, type MatchResult, matchMail, type TagRow } from "./match.js";

// The mail-link step for one new message (#224, INB-009/011/012). Plain code, headers only. A
// message is skipped unless Gmail delivered it to Paul's own mailbox. Next, the Verification
// Catcher's mail is left alone. Then matchMail decides, and its decision is recorded once. No
// body is ever fetched here, and a link never changes a status (INB-004, P1).
//
// Callers pass only mail that passed the INB-002 job-mail pre-filter (`isJobMail`), or mail to a
// known tag (INB-009: a tagged message always passes it). Anything else stamped and untagged
// would land in Paul's confirm queue as `no_match`.

// Each ATS's own sender domains, by the ATS names jobs store. They count toward senderVerified
// only: a shared ATS domain never picks an application by itself (matchMail).
export const ATS_SENDER_DOMAINS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  greenhouse: ["greenhouse.io", "greenhouse-mail.io"],
  lever: ["lever.co"],
  ashby: ["ashbyhq.com"],
  workday: ["myworkday.com", "myworkdayjobs.com"],
  smartrecruiters: ["smartrecruiters.com"],
  workable: ["workable.com", "workablemail.com"],
});

// What the database gives for an application mail can be linked to (readLinkCandidates).
export type CandidateRow = {
  applicationId: string;
  createdAt: Date;
  ats: readonly string[];
  // The company's own mail domains, as Paul entered them (NS-252); matchMail's own rules still
  // drop shared ATS and freemail domains and link by sender only for an authenticated one.
  companyDomains?: readonly string[];
};

export type LinkDecision =
  | {
      kind: "linked";
      applicationId: string;
      step: "tag" | "thread" | "sender";
      senderVerified: boolean;
    }
  | { kind: "queued"; reason: "unknown_tag" | "ambiguous" | "no_match" };

export type LinkStepDeps = {
  // Paul's own address, from Gmail's profile (GmailClient.profileAddress), read once per run.
  mailbox: string;
  // The Verification Catcher's open windows (WindowStore.openWindows).
  openWindows: () => Promise<readonly { window: VerificationWindow }[]>;
  readTags: () => Promise<readonly TagRow[]>;
  readCandidates: () => Promise<readonly CandidateRow[]>;
  readLinkedThreads: () => Promise<ReadonlyMap<string, readonly string[]>>;
  // recordMailLink: stores the decision once per message; a repeat records nothing.
  record: (input: {
    message: { id: string; threadId: string; receivedAt: Date };
    decision: LinkDecision;
  }) => Promise<{ recorded: boolean }>;
};

export type SkipReason = "spam" | "unstamped" | "verification_window" | "verification";

export type StepResult =
  | { kind: "skipped"; reason: SkipReason }
  | { kind: "linked"; applicationId: string; step: "tag" | "thread" | "sender"; recorded: boolean }
  | { kind: "queued"; reason: "unknown_tag" | "ambiguous" | "no_match"; recorded: boolean };

// Labels Gmail puts on mail it didn't receive: Paul's own sent mail and drafts. Their headers
// are whatever their author wrote.
const UNSTAMPED_LABELS = new Set(["SENT", "DRAFT"]);
// Gmail delivered these, but its own filter or Paul put them in spam or trash: never linked or
// queued (#293 item 2), so a spam message can't land in Paul's confirm queue as `no_match`.
// A second layer: the poller's search already leaves out spam and trash. Mail with no labels at
// all isn't treated as spam here.
const SPAM_LABELS = new Set(["SPAM", "TRASH"]);
// Domains whose addresses reach one mailbox however the dots in the local part are written, all
// read as `canonical`. For Gmail: googlemail.com is gmail.com, and dots don't count.
export type DotlessDomains = { domains: ReadonlySet<string>; canonical: string };
export const GMAIL_DOMAINS: DotlessDomains = {
  domains: new Set(["gmail.com", "googlemail.com"]),
  canonical: "gmail.com",
};

// An address in a comparable form: lower case, any `+…` part dropped, and for `dotless`
// domains (Gmail's own by default) the dots in the local part dropped and the domain read as
// the canonical one. Null when it isn't a plain address.
export function mailboxKey(
  address: string,
  dotless: DotlessDomains = GMAIL_DOMAINS,
): string | null {
  const raw = (address.match(/<([^>]*)>/)?.[1] ?? address).trim();
  // Printable ASCII only, before lower-casing: toLowerCase folds some other characters (the
  // Kelvin sign) into ASCII letters, so a lookalike could otherwise match Paul's address.
  if (!/^[\x21-\x7e]+$/.test(raw)) return null;
  const bare = raw.toLowerCase();
  const at = bare.lastIndexOf("@");
  if (at <= 0 || at === bare.length - 1 || /[<>"]/.test(bare)) return null;
  let local = bare.slice(0, at);
  let domain = bare.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  if (dotless.domains.has(domain)) {
    local = local.replaceAll(".", "");
    domain = dotless.canonical;
  }
  return local === "" ? null : `${local}@${domain}`;
}

// Whether Gmail delivered this message to Paul's mailbox (INB-011). Its labels must include
// neither SENT nor DRAFT (no labels at all is mail a filter archived: Gmail leaves an empty list
// out, and Sent mail and drafts always carry theirs), and the top Delivered-To (the one Gmail
// adds) must be Paul's own address. Inserted or imported mail can't be told apart from its labels; such mail whose
// author wrote Paul's address still passes, and only Paul's own authorized apps can add it.
export function isStampedDelivery(mail: MessageHeaders, mailbox: string): boolean {
  if ((mail.labelIds ?? []).some((l) => UNSTAMPED_LABELS.has(l))) return false;
  if (mail.deliveredTo === null) return false;
  const own = mailboxKey(mailbox);
  return own !== null && mailboxKey(mail.deliveredTo) === own;
}

// A database row as matchMail's candidate. Company domains come from Paul's stored list (NS-252);
// no tenant is stored yet, so a tenant tag narrows to nothing (#224 slice 1).
export function toLinkCandidate(row: CandidateRow, threadIds: readonly string[]): LinkCandidate {
  return {
    applicationId: row.applicationId,
    tenantKey: null,
    threadIds,
    companyDomains: [...(row.companyDomains ?? [])],
    atsDomains: [...new Set(row.ats.flatMap((name) => ATS_SENDER_DOMAINS[name] ?? []))],
    activeFrom: row.createdAt,
    activeUntil: null,
  };
}

const tracer = trace.getTracer("@northstar/inbox");

export async function linkNewMessage(
  deps: LinkStepDeps,
  mail: MessageHeaders,
): Promise<StepResult> {
  return tracer.startActiveSpan("mail.link", async (span) => {
    try {
      const result = await decideAndRecord(deps, mail);
      // The outcome only: never an address, subject or sender.
      span.setAttribute(
        "northstar.mail_link.outcome",
        result.kind === "skipped"
          ? `skipped:${result.reason}`
          : result.kind === "linked"
            ? result.step
            : result.reason,
      );
      if (result.kind !== "skipped")
        span.setAttribute("northstar.mail_link.recorded", result.recorded);
      return result;
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).name });
      throw e;
    } finally {
      span.end();
    }
  });
}

async function decideAndRecord(deps: LinkStepDeps, mail: MessageHeaders): Promise<StepResult> {
  if ((mail.labelIds ?? []).some((l) => SPAM_LABELS.has(l))) {
    return { kind: "skipped", reason: "spam" };
  }
  if (!isStampedDelivery(mail, deps.mailbox)) return { kind: "skipped", reason: "unstamped" };
  // The Catcher first (INB-012): mail an open window is waiting for is its own, never linked.
  const windows = await deps.openWindows();
  if (windows.some((w) => windowMatches(w.window, mail))) {
    return { kind: "skipped", reason: "verification_window" };
  }
  // A verification subject from any sender (stricter than matchMail's ATS-only check): a false
  // positive only leaves a message unlinked, which is safer than linking the Catcher's mail.
  if (hasVerificationSubject(mail.subject)) return { kind: "skipped", reason: "verification" };

  const [tags, rows, threads] = await Promise.all([
    deps.readTags(),
    deps.readCandidates(),
    deps.readLinkedThreads(),
  ]);
  const candidates = rows.map((r) => toLinkCandidate(r, threads.get(r.applicationId) ?? []));
  const match: MatchResult = matchMail(mail, tags, candidates);
  // matchMail skips verification mail itself too; checked above, so this is a guard only.
  if (match.kind === "skip") return { kind: "skipped", reason: "verification" };

  const message = { id: mail.id, threadId: mail.threadId, receivedAt: mail.receivedAt };
  if (match.kind === "linked") {
    const { recorded } = await deps.record({
      message,
      decision: {
        kind: "linked",
        applicationId: match.applicationId,
        step: match.step,
        senderVerified: match.senderVerified,
      },
    });
    return { kind: "linked", applicationId: match.applicationId, step: match.step, recorded };
  }
  const { recorded } = await deps.record({
    message,
    decision: { kind: "queued", reason: match.reason },
  });
  return { kind: "queued", reason: match.reason, recorded };
}
