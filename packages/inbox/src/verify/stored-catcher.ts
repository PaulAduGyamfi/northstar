import { randomUUID } from "node:crypto";
import {
  buildWindow,
  type CandidatePick,
  examineMessage,
  handoffLine,
  type OfferResult,
  recordCatch,
  type TimeoutResult,
  type VerificationMessage,
  type VerificationWindow,
  verifiedLine,
  type WindowSpec,
  windowMatches,
} from "./catcher.js";
import { checkLink, type LinkRefusal } from "./link-safety.js";
import { VerificationSecret } from "./secret.js";

// The Verification Catcher over a shared store (NS-151, VER-001…006): the same rules as
// createCatcher, with windows and used message ids in the database, so the process reading mail
// and the gateway waiting for the code can be different processes and survive a restart. Every
// race is settled by the store: a message is claimed once, a window restarts once and closes
// once, and a result is handed out only by the call whose close won.

export type CloseReason =
  | "verified"
  | "link_host_not_allowed"
  | "ambiguous_content"
  | "message_too_large"
  | "no_email";

export type StoredWindow = { window: VerificationWindow; ttlMs: number; resent: boolean };

// What the catcher needs from storage. @northstar/db's dbWindowStore implements it.
export interface WindowStore {
  insert(window: VerificationWindow, ttlMs: number): Promise<void>;
  // Every window not closed yet, with the resend's times when it was restarted.
  openWindows(): Promise<StoredWindow[]>;
  read(windowId: string): Promise<(StoredWindow & { closed: boolean }) | null>;
  isUsed(messageId: string): Promise<boolean>;
  // False when any window already had this message.
  claim(messageId: string, windowId: string, receivedAt: Date): Promise<boolean>;
  // False when already restarted or closed.
  restart(windowId: string, openedAt: Date, expiresAt: Date): Promise<boolean>;
  // False when already closed, or restarted since the caller read it (seenResent differs).
  close(windowId: string, reason: CloseReason, at: Date, seenResent: boolean): Promise<boolean>;
}

export interface StoredCatcher {
  open(spec: WindowSpec): Promise<VerificationWindow>;
  offer(message: VerificationMessage): Promise<OfferResult>;
  offerAssisted(message: VerificationMessage, pick: CandidatePick): Promise<OfferResult>;
  timeout(windowId: string): Promise<TimeoutResult>;
}

// Letters, digits, spaces and . & ' - (verification_window's CHECK in @northstar/db).
const WINDOW_LABEL = /^[A-Za-z0-9][A-Za-z0-9 .&'-]{0,63}$/;

type NeedsHumanReason = "link_host_not_allowed" | "ambiguous_content" | "message_too_large";

export function createStoredCatcher(deps: {
  store: WindowStore;
  now: () => Date;
  newId?: () => string;
}): StoredCatcher {
  const { store } = deps;
  const newId = deps.newId ?? randomUUID;

  async function open(spec: WindowSpec): Promise<VerificationWindow> {
    // The stored window's tenant and ATS appear in the feed, so they must be plain labels (the
    // same shape as verification_window's CHECK): pass "Acme", not a display name with commas.
    for (const [what, value] of [
      ["tenant", spec.tenant],
      ["ATS", spec.ats],
    ] as const) {
      if (!WINDOW_LABEL.test(value)) {
        throw new Error(`a stored verification window's ${what} must be a plain label like "Acme"`);
      }
    }
    const { window, ttlMs } = buildWindow(spec, newId(), deps.now());
    await store.insert(window, ttlMs);
    return window;
  }

  // Closes the window for this call. Lost to another process (already closed, or restarted since
  // it was read): this call settles nothing and hands nothing out.
  async function settle(
    s: StoredWindow,
    reason: CloseReason,
    kind: "code" | "link" | "none",
    assisted: boolean,
    result: () => OfferResult,
    pickError = false,
  ): Promise<OfferResult> {
    const won = await store.close(s.window.id, reason, deps.now(), s.resent);
    if (!won) {
      recordCatch(s.window, kind, "window_changed", assisted, pickError);
      return { status: "not_verification" };
    }
    recordCatch(s.window, kind, reason, assisted, pickError);
    return result();
  }

  function needsHuman(
    s: StoredWindow,
    kind: "link" | "none",
    reason: NeedsHumanReason,
    refusal: LinkRefusal | undefined,
    assisted: boolean,
    pickError = false,
  ): Promise<OfferResult> {
    return settle(
      s,
      reason,
      kind,
      assisted,
      () => ({
        status: "needs_human",
        windowId: s.window.id,
        reason,
        ...(refusal ? { refusal } : {}),
        feedLine: handoffLine(s.window),
      }),
      pickError,
    );
  }

  // A code or link from this window: a link must pass the host check first (VER-004).
  function deliver(
    s: StoredWindow,
    kind: "code" | "link",
    value: string,
    assisted: boolean,
  ): Promise<OfferResult> {
    let handed = value;
    if (kind === "link") {
      const check = checkLink(value, s.window.linkHosts);
      if (!check.ok) return needsHuman(s, "link", "link_host_not_allowed", check.reason, assisted);
      // The parsed form that was checked, not the raw text.
      handed = check.href;
    }
    return settle(s, "verified", kind, assisted, () => ({
      status: "verified",
      windowId: s.window.id,
      kind,
      secret: new VerificationSecret(handed),
      feedLine: verifiedLine(s.window),
    }));
  }

  async function offerWith(
    message: VerificationMessage,
    pick: CandidatePick | null,
  ): Promise<OfferResult> {
    if (await store.isUsed(message.messageId)) return { status: "not_verification" };
    const candidates = (await store.openWindows()).filter((s) => windowMatches(s.window, message));
    if (candidates.length === 0) return { status: "not_verification" };
    // Two sessions waiting on the same sender: neither gets the mail, and both time out alone.
    if (candidates.length > 1) {
      for (const s of candidates) recordCatch(s.window, "none", "ambiguous_window");
      return { status: "ambiguous_window" };
    }
    const s = candidates[0] as StoredWindow;
    // Claimed before anything is read out of it: another process offering the same mail loses.
    if (!(await store.claim(message.messageId, s.window.id, message.receivedAt))) {
      return { status: "not_verification" };
    }
    const found = examineMessage(message);
    if (found.kind === "too_large") {
      return needsHuman(s, "none", "message_too_large", undefined, false);
    }
    if (found.kind === "none") {
      // From the right sender but nothing to use (a welcome mail): the window keeps waiting.
      recordCatch(s.window, "none", "no_code_or_link");
      return { status: "no_code_or_link", windowId: s.window.id };
    }
    if (found.kind !== "ambiguous") return deliver(s, found.kind, found.value, false);
    if (pick === null) return needsHuman(s, "none", "ambiguous_content", undefined, false);
    let choice: number | null = null;
    try {
      choice = await pick({ body: found.body, kind: found.which, candidates: found.candidates });
    } catch {
      // The model is down or refused: the same handoff as without a fallback, flagged on the span
      // like createCatcher's (never the error's message, which could quote the email).
      return needsHuman(s, "none", "ambiguous_content", undefined, true, true);
    }
    const chosen =
      choice !== null && Number.isInteger(choice) && choice >= 0
        ? found.candidates[choice]
        : undefined;
    if (chosen === undefined) return needsHuman(s, "none", "ambiguous_content", undefined, true);
    // If the window was restarted while pick ran, the close in deliver loses and nothing is
    // handed out: a resend voids the codes this mail carried.
    return deliver(s, found.which, chosen, true);
  }

  async function timeout(windowId: string): Promise<TimeoutResult> {
    const s = await store.read(windowId);
    if (!s || s.closed) return { action: "closed", windowId };
    const w = s.window;
    const now = deps.now();
    if (now.getTime() < w.expiresAt.getTime()) {
      return { action: "wait", windowId, expiresAt: w.expiresAt };
    }
    if (!s.resent) {
      // One "resend code" (VER-006): the window restarts at now. Lost to another process: read
      // what it did instead.
      const expiresAt = new Date(now.getTime() + s.ttlMs);
      if (!(await store.restart(windowId, now, expiresAt))) return timeout(windowId);
      recordCatch({ ...w, openedAt: now, expiresAt }, "none", "resend");
      return { action: "resend", windowId, expiresAt };
    }
    if (!(await store.close(windowId, "no_email", now, true))) return timeout(windowId);
    recordCatch(w, "none", "no_email");
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

  return {
    open,
    offer: (message) => offerWith(message, null),
    offerAssisted: (message, pick) => offerWith(message, pick),
    timeout,
  };
}
