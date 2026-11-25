import { randomUUID } from "node:crypto";
import { trace } from "@opentelemetry/api";
import { isAuthenticatedSender, underDomain } from "../prefilter.js";
import { extractVerification, htmlToText } from "./extract.js";
import { checkLink, type LinkRefusal } from "./link-safety.js";
import { VerificationSecret } from "./secret.js";

// The Verification Catcher's core (VER-001…006, ADR-0010 item 4). A gateway step that expects a
// code or magic link by email opens a window; each new message is offered; the catcher hands back
// the code or link only for an authenticated, allowlisted sender, inside the window, once. Plain
// code, no Gmail call, no model, no fetch. Windows live in memory until the gateway session that
// owns them (NS-124) gives them a home in the database.

export type Purpose = "sign_up" | "sign_in" | "submit" | "password_reset";

export type WindowSpec = {
  tenant: string;
  ats: string;
  purpose: Purpose;
  // Domains the email may come from (the tenant's or the ATS's), and their subdomains.
  senderDomains: readonly string[];
  // Hosts a magic link may point to, and their subdomains. Empty: links are never opened.
  linkHosts: readonly string[];
  ttlMs?: number;
};

export type VerificationWindow = Readonly<{
  id: string;
  tenant: string;
  ats: string;
  purpose: Purpose;
  senderDomains: readonly string[];
  linkHosts: readonly string[];
  openedAt: Date;
  expiresAt: Date;
}>;

// What the inbox reader passes in: headers Gmail set, and the body. The body is untrusted text.
export type VerificationMessage = {
  messageId: string;
  senderDomain: string;
  authenticationResults: string | null;
  receivedAt: Date;
  text: string;
  html: string | null;
};

export type OfferResult =
  | { status: "not_verification" }
  | { status: "ambiguous_window" }
  | { status: "no_code_or_link"; windowId: string }
  | {
      status: "verified";
      windowId: string;
      kind: "code" | "link";
      secret: VerificationSecret;
      feedLine: string;
    }
  | {
      status: "needs_human";
      windowId: string;
      reason: "link_host_not_allowed" | "ambiguous_content" | "message_too_large";
      refusal?: LinkRefusal;
      feedLine: string;
    };

export type TimeoutResult =
  | { action: "wait"; windowId: string; expiresAt: Date }
  | { action: "resend"; windowId: string; expiresAt: Date }
  | {
      action: "needs_human";
      windowId: string;
      reason: "no_email";
      expected: Pick<VerificationWindow, "tenant" | "ats" | "purpose" | "senderDomains">;
      feedLine: string;
    }
  | { action: "closed"; windowId: string };

// Chooses one of several candidates plain code found in an ambiguous message (NS-149, VER-003):
// an index into `candidates`, or null. It only chooses, never invents: the catcher still checks
// the choice (a link must pass checkLink). modelPick (model-pick.ts) is the model-backed one.
export type CandidatePick = (input: {
  body: string;
  kind: "code" | "link";
  candidates: string[];
}) => Promise<number | null>;

export interface Catcher {
  open(spec: WindowSpec): VerificationWindow;
  offer(message: VerificationMessage): OfferResult;
  // offer, but ambiguous content is put to `pick` before it becomes needs_human.
  offerAssisted(message: VerificationMessage, pick: CandidatePick): Promise<OfferResult>;
  timeout(windowId: string): TimeoutResult;
}

// What offer decided, or the ambiguous candidates still to be chosen among.
type Decision =
  | { done: OfferResult }
  | {
      ambiguous: {
        window: VerificationWindow;
        kind: "code" | "link";
        candidates: string[];
        body: string;
      };
    };

export const DEFAULT_WINDOW_MS = 10 * 60_000; // VER-001's default
export const MAX_WINDOW_MS = 30 * 60_000; // a code older than this is no use to anyone

type State = { window: VerificationWindow; ttlMs: number; resent: boolean };

// A body larger than this is not a verification mail; scanning it would only cost time.
export const MAX_BODY_CHARS = 256 * 1024;

// Gmail's own Authentication-Results header starts with this authserv-id. One added by any other
// server (or by the sender, before Gmail) proves nothing.
const GMAIL_AUTHSERV = /^\s*mx\.google\.com\s*;/i;

// An allowlist entry is a plain host name with at least one dot: no wildcard, no bare "com", no
// leading or trailing dot, no IP address. A bad entry would allow far more than one tenant.
const ALLOWLIST_ENTRY = /^(?=.*[a-z])[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function allowlist(entries: readonly string[], what: string): readonly string[] {
  const out = entries.map((e) => e.toLowerCase());
  for (const e of out) {
    if (!ALLOWLIST_ENTRY.test(e) || /^[0-9.]+$/.test(e)) {
      throw new Error(`a verification window's ${what} must be host names like "example.com"`);
    }
  }
  return Object.freeze(out);
}

// Feed lines name the tenant and ATS only, never the code, link or address (VER-005).
const verifiedLine = (w: VerificationWindow) => `Verified email for ${w.tenant} (${w.ats})`;
const handoffLine = (w: VerificationWindow) =>
  `Couldn't verify email for ${w.tenant} (${w.ats}): needs your hands`;

export function createCatcher(deps: { now: () => Date; newId?: () => string }): Catcher {
  const newId = deps.newId ?? randomUUID;
  // Open windows only: a window is removed the moment it closes, so the map stays small.
  const windows = new Map<string, State>();
  // Message ids already given to a window (one email verifies at most one step), with the time
  // each was received, so entries no open window could ever match again can be dropped.
  const usedMessages = new Map<string, number>();
  const tracer = trace.getTracer("@northstar/inbox");

  // One span per decision, with ids and outcome only: never the code, link, subject or sender.
  function record(
    w: VerificationWindow,
    kind: "code" | "link" | "none",
    outcome: string,
    assisted = false,
    pickError = false,
  ): void {
    tracer
      .startSpan("verification.catch", {
        attributes: {
          "verification.window_id": w.id,
          "verification.tenant": w.tenant,
          "verification.ats": w.ats,
          "verification.purpose": w.purpose,
          "verification.kind": kind,
          "verification.outcome": outcome,
          // Only when a pick (the model fallback) was asked; never what it chose.
          ...(assisted ? { "verification.assisted": true } : {}),
          // The pick threw (model down, transport error), as opposed to answering null. A flag
          // only: the error's message could quote the email.
          ...(pickError ? { "verification.pick_error": true } : {}),
        },
      })
      .end();
  }

  function close(w: VerificationWindow): void {
    windows.delete(w.id);
    // A message received before every open window opened (and before now, when new windows
    // open) can never match one again.
    const oldest = Math.min(
      deps.now().getTime(),
      ...[...windows.values()].map((s) => s.window.openedAt.getTime()),
    );
    for (const [id, receivedAt] of usedMessages) {
      if (receivedAt < oldest) usedMessages.delete(id);
    }
  }

  function matches(s: State, m: VerificationMessage): boolean {
    const w = s.window;
    const domain = m.senderDomain.toLowerCase();
    return (
      m.receivedAt.getTime() >= w.openedAt.getTime() &&
      m.receivedAt.getTime() <= w.expiresAt.getTime() &&
      w.senderDomains.some((d) => underDomain(domain, d)) &&
      // The From domain alone is forgeable: Gmail must have verified it (DMARC or DKIM pass),
      // in the header Gmail itself wrote.
      GMAIL_AUTHSERV.test(m.authenticationResults ?? "") &&
      isAuthenticatedSender({
        senderDomain: domain,
        authenticationResults: m.authenticationResults,
      })
    );
  }

  function open(spec: WindowSpec): VerificationWindow {
    if (spec.senderDomains.length === 0) {
      throw new Error("a verification window needs at least one sender domain");
    }
    const ttlMs = Math.min(spec.ttlMs ?? DEFAULT_WINDOW_MS, MAX_WINDOW_MS);
    if (!(ttlMs > 0)) throw new Error("a verification window needs a positive duration");
    const senderDomains = allowlist(spec.senderDomains, "sender domains");
    const linkHosts = allowlist(spec.linkHosts, "link hosts");
    const openedAt = deps.now();
    const window: VerificationWindow = Object.freeze({
      id: newId(),
      tenant: spec.tenant,
      ats: spec.ats,
      purpose: spec.purpose,
      senderDomains,
      linkHosts,
      openedAt,
      expiresAt: new Date(openedAt.getTime() + ttlMs),
    });
    windows.set(window.id, { window, ttlMs, resent: false });
    return window;
  }

  function needsHuman(
    w: VerificationWindow,
    kind: "link" | "none",
    reason: "link_host_not_allowed" | "ambiguous_content" | "message_too_large",
    refusal?: LinkRefusal,
    assisted = false,
  ): OfferResult {
    close(w);
    record(w, kind, reason, assisted);
    return {
      status: "needs_human",
      windowId: w.id,
      reason,
      ...(refusal ? { refusal } : {}),
      feedLine: handoffLine(w),
    };
  }

  function verified(
    w: VerificationWindow,
    kind: "code" | "link",
    value: string,
    assisted = false,
  ): OfferResult {
    close(w);
    record(w, kind, "verified", assisted);
    const secret = new VerificationSecret(value);
    return { status: "verified", windowId: w.id, kind, secret, feedLine: verifiedLine(w) };
  }

  // A code or link from this window: a link must pass the host check first (VER-004).
  function deliver(
    w: VerificationWindow,
    kind: "code" | "link",
    value: string,
    assisted = false,
  ): OfferResult {
    if (kind === "code") return verified(w, "code", value, assisted);
    const check = checkLink(value, w.linkHosts);
    if (!check.ok) {
      return needsHuman(w, "link", "link_host_not_allowed", check.reason, assisted);
    }
    // The parsed form that was checked, not the raw text: another URL parser must not be able
    // to read a different host out of it.
    return verified(w, "link", check.href, assisted);
  }

  function decide(message: VerificationMessage): Decision {
    if (usedMessages.has(message.messageId)) return { done: { status: "not_verification" } };
    const candidates = [...windows.values()].filter((s) => matches(s, message));
    if (candidates.length === 0) return { done: { status: "not_verification" } };
    // Two sessions waiting on the same sender: the mail can't say which one it's for, so neither
    // gets it. Both stay open and time out on their own (VER-006); the spans show why.
    if (candidates.length > 1) {
      for (const s of candidates) record(s.window, "none", "ambiguous_window");
      return { done: { status: "ambiguous_window" } };
    }
    const w = (candidates[0] as State).window;
    usedMessages.set(message.messageId, message.receivedAt.getTime());

    if (message.text.length > MAX_BODY_CHARS || (message.html?.length ?? 0) > MAX_BODY_CHARS) {
      return { done: needsHuman(w, "none", "message_too_large") };
    }
    const { codes, links } = extractVerification(message.text, message.html);
    // A code wins over links: verify mails often carry both, and a code needs no navigation.
    if (codes.length > 1 || (codes.length === 0 && links.length > 1)) {
      const body = message.text.trim() !== "" ? message.text : htmlToText(message.html ?? "");
      return codes.length > 1
        ? { ambiguous: { window: w, kind: "code", candidates: codes, body } }
        : { ambiguous: { window: w, kind: "link", candidates: links, body } };
    }
    if (codes.length === 1) return { done: deliver(w, "code", codes[0] as string) };
    if (links.length === 1) return { done: deliver(w, "link", links[0] as string) };
    // From the right sender but nothing to use (a welcome mail): the window keeps waiting.
    record(w, "none", "no_code_or_link");
    return { done: { status: "no_code_or_link", windowId: w.id } };
  }

  function offer(message: VerificationMessage): OfferResult {
    const d = decide(message);
    if ("done" in d) return d.done;
    return needsHuman(d.ambiguous.window, "none", "ambiguous_content");
  }

  async function offerAssisted(
    message: VerificationMessage,
    pick: CandidatePick,
  ): Promise<OfferResult> {
    const d = decide(message);
    if ("done" in d) return d.done;
    const { window: w, kind, candidates, body } = d.ambiguous;
    let choice: number | null = null;
    let pickError = false;
    try {
      choice = await pick({ body, kind, candidates });
    } catch {
      // The model is down or refused: the same handoff as without a fallback.
      pickError = true;
    }
    // While pick ran, the window may have been settled by another mail or restarted by a resend
    // (which voids the codes this mail carried). Then this mail settles nothing and posts no feed
    // line: a restarted window keeps waiting for the new code, a settled one already has its result.
    if (windows.get(w.id)?.window !== w) {
      record(w, "none", "window_changed", true, pickError);
      return windows.has(w.id)
        ? { status: "no_code_or_link", windowId: w.id }
        : { status: "not_verification" };
    }
    if (pickError) {
      close(w);
      record(w, "none", "ambiguous_content", true, true);
      return {
        status: "needs_human",
        windowId: w.id,
        reason: "ambiguous_content",
        feedLine: handoffLine(w),
      };
    }
    const chosen =
      choice !== null && Number.isInteger(choice) && choice >= 0 ? candidates[choice] : undefined;
    if (chosen === undefined) return needsHuman(w, "none", "ambiguous_content", undefined, true);
    return deliver(w, kind, chosen, true);
  }

  function timeout(windowId: string): TimeoutResult {
    const state = windows.get(windowId);
    if (!state) return { action: "closed", windowId };
    const w = state.window;
    const now = deps.now();
    if (now.getTime() < w.expiresAt.getTime()) {
      return { action: "wait", windowId, expiresAt: w.expiresAt };
    }
    if (!state.resent) {
      // One "resend code" (VER-006). The window restarts at now: many ATSs void the old code on
      // resend, so a late first email must not hand the gateway a dead code.
      state.resent = true;
      state.window = Object.freeze({
        ...w,
        openedAt: now,
        expiresAt: new Date(now.getTime() + state.ttlMs),
      });
      record(state.window, "none", "resend");
      return { action: "resend", windowId, expiresAt: state.window.expiresAt };
    }
    close(w);
    record(w, "none", "no_email");
    return {
      action: "needs_human",
      windowId,
      reason: "no_email",
      expected: {
        tenant: w.tenant,
        ats: w.ats,
        purpose: w.purpose,
        senderDomains: w.senderDomains,
      },
      feedLine: handoffLine(w),
    };
  }

  return { open, offer, offerAssisted, timeout };
}
