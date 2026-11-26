import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { GmailClient } from "../gmail.js";
import type { CandidatePick, Catcher, OfferResult, VerificationWindow } from "./catcher.js";

// Polling Gmail while a verification window is open (NS-148, VER-002). Decided on #89: poll
// instead of push, so there is no Pub/Sub topic and no stored token (ADR-0014). It runs only
// while a window is open and never past its end. Plain code; Gmail, the clock and sleep are
// injected.

// The two reads it needs from the read-only client (gmail.ts).
export type PollGmail = Pick<GmailClient, "listIds" | "getFull">;

export type PollDeps = {
  gmail: PollGmail;
  catcher: Pick<Catcher, "offer" | "offerAssisted">;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  // The model fallback for an ambiguous mail (NS-149); without it, ambiguity is a handoff.
  pick?: CandidatePick;
};

export type PollResult =
  | Extract<OfferResult, { status: "verified" | "needs_human" }>
  // The window ended with no usable mail: the caller asks catcher.timeout (resend once, then
  // needs_human; VER-006). The last Gmail error's name, never its message, when one happened.
  | { status: "timed_out"; windowId: string; lastError: string | null };

// A verification code is wanted within seconds, but Gmail's quota is counted per minute.
export const POLL_INTERVAL_MS = 5_000;
// New messages offered a tick: a flood from the sender's domain can't make one tick do
// unbounded work. The rest wait for the next tick.
export const MAX_PER_TICK = 10;
// Clock skew between this machine and Gmail: ask for a minute before the window opened. The
// catcher still refuses anything received outside the window.
const SKEW_S = 60;

// The one Gmail query: the window's sender domains, since it opened. The domains passed the
// catcher's allowlist check (letters, digits, dots and hyphens only). Each is quoted anyway, so a
// domain that starts with "-" can't read as Gmail's "not from" and list nearly all mail.
export function windowQuery(window: VerificationWindow): string {
  const since = Math.floor(window.openedAt.getTime() / 1000) - SKEW_S;
  const from = window.senderDomains.map((d) => `"${d}"`).join(" OR ");
  return `from:(${from}) after:${since}`;
}

export function pollWindow(
  deps: PollDeps,
  window: VerificationWindow,
  options: { intervalMs?: number } = {},
): Promise<PollResult> {
  const interval = options.intervalMs ?? POLL_INTERVAL_MS;
  return trace
    .getTracer("@northstar/inbox")
    .startActiveSpan("verification.poll", async (span): Promise<PollResult> => {
      // Ids only: never the query (it names senders), a subject or a code.
      span.setAttribute("verification.window_id", window.id);
      const seen = new Set<string>();
      let ticks = 0;
      let offered = 0;
      let lastError: string | null = null;
      const finish = (result: PollResult): PollResult => {
        span.setAttributes({
          "verification.poll.ticks": ticks,
          "verification.poll.offered": offered,
          "verification.poll.outcome": result.status,
        });
        if (lastError !== null) span.setAttribute("verification.poll.last_error", lastError);
        span.end();
        return result;
      };
      try {
        while (deps.now().getTime() < window.expiresAt.getTime()) {
          ticks++;
          // Only the two Gmail calls are guarded: a failed read (Gmail down, the gmail breaker
          // open) never ends the wait, and the next tick retries. A bug in the catcher still
          // throws, so it isn't mistaken for Gmail trouble and retried until the window ends.
          const gmailCall = async <T>(call: () => Promise<T>): Promise<T | undefined> => {
            try {
              return await call();
            } catch (error) {
              // Named only: a message could quote the request.
              lastError = error instanceof Error ? error.name : "Error";
              return undefined;
            }
          };
          const ids = await gmailCall(() => deps.gmail.listIds(windowQuery(window)));
          const fresh = (ids ?? []).filter((m) => !seen.has(m.id)).slice(0, MAX_PER_TICK);
          for (const { id } of fresh) {
            const full = await gmailCall(() => deps.gmail.getFull(id));
            // Not seen until fetched: a failed fetch is tried again next tick, so one failed
            // read can't hide the code mail for the rest of the window.
            if (full === undefined) break;
            seen.add(id);
            offered++;
            // The body is untrusted text: the catcher only extracts from it. Known gap: getFull
            // gives the text part (or text made from the HTML, without its links), not the raw
            // HTML, so a magic link that exists only as an HTML button isn't seen. That mail
            // ends as no_code_or_link and the window waits, then resends (fail safe).
            const msg = {
              messageId: full.id,
              senderDomain: full.senderDomain,
              authenticationResults: full.authenticationResults,
              receivedAt: full.receivedAt,
              text: full.body,
              html: null,
            };
            const result = deps.pick
              ? await deps.catcher.offerAssisted(msg, deps.pick)
              : deps.catcher.offer(msg);
            if (result.status === "verified" || result.status === "needs_human") {
              return finish(result);
            }
          }
          // Never sleep past the window's end. Known gap: one Gmail call can itself take minutes
          // (the client's retries and Retry-After), so the result can come after expiresAt. A
          // deadline for the client is for the gateway session that wires this (NS-151).
          const left = window.expiresAt.getTime() - deps.now().getTime();
          if (left <= 0) break;
          await deps.sleep(Math.min(interval, left));
        }
        return finish({ status: "timed_out", windowId: window.id, lastError });
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.name : "Error",
        });
        span.end();
        throw error;
      }
    });
}
