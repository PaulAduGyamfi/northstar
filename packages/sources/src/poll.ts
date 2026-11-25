import type { DedupeCandidate, NextState, PollResult, Watch } from "@northstar/db";
import type { CallDecision, CallOutcome } from "@northstar/domain";
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

// The kill switch and circuit breaker for each ATS (RES-008, RES-002), both named
// `source:<ats>`. bin.ts wires them to packages/db; tests pass fakes.
export type PollGuard = {
  isOn: (subsystem: string) => Promise<boolean>;
  acquire: (dependency: string) => Promise<CallDecision>;
  report: (dependency: string, outcome: CallOutcome, probeToken: string | null) => Promise<void>;
};

export type PollDeps = FetchDeps & {
  guard: PollGuard;
  store: {
    due: (now: Date) => Promise<Watch[]>;
    candidates: () => Promise<DedupeCandidate[]>;
    save: IngestDeps["store"]["save"];
    record: (watch: Watch, now: Date, result: PollResult, next: NextState) => Promise<void>;
  };
};

export type PassSummary = {
  boards: number;
  added: number;
  failed: number;
  quarantined: number;
  // Boards held back by a kill switch or an open breaker; set only when there was one.
  paused?: number;
};

export async function pollDue(deps: PollDeps, now: Date): Promise<PassSummary> {
  const due = await deps.store.due(now);
  const summary: PassSummary = { boards: due.length, added: 0, failed: 0, quarantined: 0 };
  // One board at a time: a pass is small, and it keeps each ATS at one request at a time.
  for (const watch of due) {
    const admission = await admit(deps.guard, watch);
    if (!admission.ok) {
      // Not read and not recorded: the board stays due, its own backoff untouched, and it is
      // read on the first pass after the switch is back on or the breaker lets calls through.
      pausedSpan(watch, admission);
      summary.paused = (summary.paused ?? 0) + 1;
      continue;
    }
    const result = await pollBoard(deps, watch, admission);
    const next = nextState(watch, result.outcome === "ok", now);
    await deps.store.record(watch, now, result, next);
    summary.added += result.added;
    if (result.outcome === "failed") summary.failed++;
    if (next.status === "quarantined") summary.quarantined++;
  }
  return summary;
}

type Admission =
  | { ok: false; by: "kill_switch" | "breaker" }
  // The check itself failed; `error` is the error's name, never its message.
  | { ok: false; by: "guard_error"; error: string }
  // `dependency` is null when there is no call to guard (Workday boards are never read).
  | { ok: true; dependency: string | null; probeToken: string | null };

// May this board be read now? Its ATS's switch must be on and its breaker must allow the call.
// A check that throws (Postgres down) holds the board back: no unguarded call goes out.
async function admit(guard: PollGuard, watch: Watch): Promise<Admission> {
  if (watch.ats === "workday") return { ok: true, dependency: null, probeToken: null };
  const name = `source:${watch.ats}`;
  try {
    if (!(await guard.isOn(name))) return { ok: false, by: "kill_switch" };
    const decision = await guard.acquire(name);
    if (!decision.allowed) return { ok: false, by: "breaker" };
    return { ok: true, dependency: name, probeToken: decision.probe ? decision.probeToken : null };
  } catch (error) {
    return { ok: false, by: "guard_error", error: errorName(error) };
  }
}

// A held-back board leaves a trace, so "why wasn't this board read?" has an answer.
function pausedSpan(watch: Watch, admission: Admission & { ok: false }): void {
  const span = trace.getTracer("@northstar/sources").startSpan("source.poll.paused");
  span.setAttributes({
    "source.ats": watch.ats,
    "source.watch_id": watch.id,
    "source.paused_by": admission.by,
  });
  // Tells "Postgres down" from a bad name in traces, by error name only.
  if (admission.by === "guard_error") span.setAttribute("source.guard_error", admission.error);
  span.end();
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
function pollBoard(
  deps: PollDeps,
  watch: Watch,
  admission: { dependency: string | null; probeToken: string | null },
): Promise<PollResult> {
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
      // Tells the ATS's breaker how the board read went. Only the read counts: saving postings
      // is our database, not the ATS. A report that fails is noted and the poll goes on.
      const report = async (outcome: CallOutcome) => {
        if (admission.dependency === null) return;
        try {
          await deps.guard.report(admission.dependency, outcome, admission.probeToken);
        } catch {
          span.setAttribute("source.breaker_report_failed", true);
        }
      };
      try {
        if (watch.ats === "workday") throw new Error("Workday boards aren't polled");
        let postings: Awaited<ReturnType<typeof listBoard>>;
        try {
          postings = await listBoard(deps, { ats: watch.ats, board: watch.board });
        } catch (error) {
          await report({ ok: false, error: errorName(error) });
          throw error;
        }
        await report({ ok: true });
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
