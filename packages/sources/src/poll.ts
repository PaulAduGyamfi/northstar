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
// becomes a result for this board alone (ADR-0007), so the pass goes on. One posting that won't
// save is counted and skipped; the board fails only when every new posting failed (the database
// is down, say) or the board itself couldn't be read.
function pollBoard(deps: PollDeps, watch: Watch): Promise<PollResult> {
  return trace
    .getTracer("@northstar/sources")
    .startActiveSpan("source.poll", async (span): Promise<PollResult> => {
      span.setAttribute("source.ats", watch.ats);
      // The watch's random id, never the board's name or a hash of it: board names are short
      // and public, so a hash could be reversed to learn which companies Paul watches.
      span.setAttribute("source.watch_id", watch.id);
      let seen = 0;
      let added = 0;
      let failed = 0;
      let lastError: string | null = null;
      const finish = (outcome: PollResult["outcome"]): PollResult => {
        span.setAttributes({
          "source.outcome": outcome,
          "source.seen": seen,
          "source.added": added,
          "source.failed": failed,
        });
        if (outcome === "failed") {
          span.setStatus({ code: SpanStatusCode.ERROR, message: lastError ?? "Error" });
        }
        return { outcome, seen, added, failed, errorName: lastError };
      };
      try {
        if (watch.ats === "workday") throw new Error("Workday boards aren't polled");
        const postings = await listBoard(deps, { ats: watch.ats, board: watch.board });
        seen = postings.length;
        const existing = await deps.store.candidates();
        const known = new Known(existing);
        let tried = 0;
        for (const p of postings) {
          const x = p.extraction;
          // Known by its ATS id or its link: nothing to read, nothing to change.
          if (known.has(p.url, x)) continue;
          tried++;
          try {
            const saved = await storeExtraction(deps, existing, p.url, x);
            if (saved.status === "created") added++;
            // So the next posting on this board is compared against this one too.
            if (saved.status === "created" || saved.status === "merged") {
              remember(existing, saved.jobId, p.url, x);
              known.add(p.url, x);
            }
          } catch (error) {
            failed++;
            lastError = errorName(error);
          }
        }
        return finish(tried > 0 && failed === tried ? "failed" : "ok");
      } catch (error) {
        lastError = errorName(error);
        return finish("failed");
      } finally {
        span.end();
      }
    });
}

// The links and ATS ids already stored, for a constant-time "seen before?" per posting.
class Known {
  private readonly keys = new Set<string>();
  constructor(existing: DedupeCandidate[]) {
    for (const j of existing) for (const s of j.sources) this.addKeys(s.url, s.ats, s.atsPostingId);
  }
  has(url: string, x: Extraction): boolean {
    return (
      this.keys.has(`url:${url}`) ||
      (x.atsPostingId !== null && this.keys.has(`ats:${x.ats}:${x.atsPostingId}`))
    );
  }
  add(url: string, x: Extraction): void {
    this.addKeys(url, x.ats, x.atsPostingId);
  }
  private addKeys(url: string, ats: string | null, id: string | null): void {
    this.keys.add(`url:${url}`);
    if (id !== null) this.keys.add(`ats:${ats}:${id}`);
  }
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : "Error");

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
