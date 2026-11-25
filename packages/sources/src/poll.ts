import { createHash } from "node:crypto";
import type { DedupeCandidate, NextState, PollResult, Watch } from "@northstar/db";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { listBoard } from "./boards/list.js";
import type { Extraction } from "./extraction.js";
import type { FetchDeps } from "./fetch.js";
import { type IngestDeps, storeExtraction } from "./ingest.js";

// One poll pass over the watchlist (SRC-003, ADR-0015). Plain function, every dependency passed
// in, no process state: `jobs run` calls it once a minute today, a Temporal activity later.

// Minutes between polls per tier (SRC-012): inside each SLO (15 min, 30 min, 2 h) with room for
// one failed poll.
export const TIER_MINUTES: Record<1 | 2 | 3, number> = { 1: 10, 2: 20, 3: 60 };
// Backoff (RES-002): a failing board's interval doubles per failure, up to 6 hours.
export const MAX_BACKOFF_MINUTES = 6 * 60;
// Quarantine (RES-003): skipped until Paul runs `jobs watch retry`.
export const QUARANTINE_AFTER = 5;

export type PollDeps = FetchDeps & {
  store: {
    due: (now: Date) => Promise<Watch[]>;
    candidates: () => Promise<DedupeCandidate[]>;
    save: IngestDeps["store"]["save"];
    record: (watch: Watch, now: Date, result: PollResult, next: NextState) => Promise<void>;
  };
};

export type PassSummary = { boards: number; added: number; failed: number; quarantined: number };

export async function pollDue(deps: PollDeps, now: Date): Promise<PassSummary> {
  const due = await deps.store.due(now);
  const summary: PassSummary = { boards: due.length, added: 0, failed: 0, quarantined: 0 };
  // One board at a time: a pass is small, and it keeps each ATS at one request at a time.
  for (const watch of due) {
    const result = await pollBoard(deps, watch);
    const next = nextState(watch, result.outcome === "ok", now);
    await deps.store.record(watch, now, result, next);
    summary.added += result.added;
    if (result.outcome === "failed") summary.failed++;
    if (next.status === "quarantined") summary.quarantined++;
  }
  return summary;
}

// When the board is next due and in what state, from this poll's outcome.
export function nextState(watch: Watch, ok: boolean, now: Date): NextState {
  const base = TIER_MINUTES[watch.tier];
  if (ok) return { nextPollAt: addMinutes(now, base), status: "ok", consecutiveFailures: 0 };
  const failures = watch.consecutiveFailures + 1;
  const wait = Math.min(base * 2 ** failures, MAX_BACKOFF_MINUTES);
  return {
    nextPollAt: addMinutes(now, wait),
    status: failures >= QUARANTINE_AFTER ? "quarantined" : "backing_off",
    consecutiveFailures: failures,
  };
}

// Reads one board and saves its new postings. Never throws: any failure, ours or the board's,
// becomes a failed result for this board alone (ADR-0007), so the pass goes on.
function pollBoard(deps: PollDeps, watch: Watch): Promise<PollResult> {
  return trace
    .getTracer("@northstar/sources")
    .startActiveSpan("source.poll", async (span): Promise<PollResult> => {
      span.setAttribute("source.ats", watch.ats);
      // A hash, not the board's name: the name says which companies Paul is watching.
      span.setAttribute("source.board_hash", hash(`${watch.ats}/${watch.board}`));
      let seen = 0;
      let added = 0;
      try {
        if (watch.ats === "workday") throw new Error("Workday boards aren't polled");
        const postings = await listBoard(deps, { ats: watch.ats, board: watch.board });
        seen = postings.length;
        const existing = await deps.store.candidates();
        for (const p of postings) {
          const x = p.extraction;
          // Known by its ATS id or its link: nothing to read, nothing to change.
          const known = existing.some((j) =>
            j.sources.some(
              (s) =>
                s.url === p.url ||
                (x.atsPostingId !== null && s.ats === x.ats && s.atsPostingId === x.atsPostingId),
            ),
          );
          if (known) continue;
          const saved = await storeExtraction(deps, existing, p.url, x);
          if (saved.status === "created" || saved.status === "merged") {
            if (saved.status === "created") added++;
            // So the next posting on this board is compared against this one too.
            remember(existing, saved.jobId, p.url, x);
          }
        }
        span.setAttributes({ "source.outcome": "ok", "source.seen": seen, "source.added": added });
        return { outcome: "ok", seen, added, errorName: null };
      } catch (error) {
        const name = error instanceof Error ? error.name : "Error";
        span.setAttributes({
          "source.outcome": "failed",
          "source.seen": seen,
          "source.added": added,
        });
        span.setStatus({ code: SpanStatusCode.ERROR, message: name });
        return { outcome: "failed", seen, added, errorName: name };
      } finally {
        span.end();
      }
    });
}

function remember(existing: DedupeCandidate[], jobId: string, url: string, x: Extraction): void {
  const source = { url, ats: x.ats, atsPostingId: x.atsPostingId };
  const job = existing.find((j) => j.jobId === jobId);
  if (job) {
    job.sources.push(source);
    return;
  }
  existing.push({
    jobId,
    company: x.fields.company,
    title: x.fields.title,
    location: x.fields.location,
    description: x.fields.description,
    sources: [source],
  });
}

const addMinutes = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
