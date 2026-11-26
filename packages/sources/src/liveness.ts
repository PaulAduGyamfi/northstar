import type { JobToCheck, PostingOutcome } from "@northstar/db";
import type { CallOutcome } from "@northstar/domain";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { z } from "zod";
import { type AtsTarget, detectAts } from "./ats/detect.js";
import { safeJson } from "./ats/greenhouse.js";
import { BOARD_MAX_BYTES, type FetchDeps, safeFetch } from "./fetch.js";
import type { PollGuard } from "./poll.js";

// Posting liveness (NS-173 slice 2, SRC-010): re-check a saved job's posting through the ATS's
// public API, one request per job (one per Ashby board), through safeFetch. "closed" only on the
// ATS's own answer that the posting is gone (a 404 for the posting, or absent from a board that
// answered); anything else (a refused fetch, a 5xx, a board that's gone) is "unavailable" and
// stores nothing. A job closes only after two closed answers in a row (packages/db), so one
// mistaken 404 never removes it.

export type Liveness = PostingOutcome;
// What one check found, and whether the ATS failed to answer (a 5xx or 429): only that counts
// against its breaker. A 404, for a posting or a whole board, is the ATS answering.
// `requested` is false when no request went out for this job (a board another job of the pass
// already read, or a link with no API): then nothing is reported to the breaker, so one board read
// counts once however many saved jobs it serves.
export type CheckResult = { liveness: Liveness; failed: boolean; requested: boolean };

const AshbyIds = z.object({ jobs: z.array(z.object({ id: z.string() })) });

const failedStatus = (status: number) => status === 429 || status >= 500;
const byStatus = (status: number): CheckResult => ({
  liveness: status === 200 ? "open" : status === 404 ? "closed" : "unavailable",
  failed: failedStatus(status),
  requested: true,
});

// The posting a stored link names, when its ATS has a public API we can ask: null otherwise. EU
// Lever postings (jobs.eu.lever.co) live on api.eu.lever.co, which isn't on our allowlist yet, and
// the US API would answer 404 for them, so they aren't checked rather than wrongly closed.
export function checkTarget(url: string): AtsTarget | null {
  const t = detectAts(url);
  if (!t) return null;
  if (t.ats === "lever" && new URL(url).hostname !== "jobs.lever.co") return null;
  return ["greenhouse", "lever", "ashby", "smartrecruiters"].includes(t.ats) ? t : null;
}

// One Ashby board's posting ids per org, shared by a pass so a board is read once.
export type BoardCache = Map<string, Promise<{ ids: Set<string> | null; failed: boolean }>>;

// Never throws: a refused or failed fetch is a failed read, so the cached promise is never a
// rejection that every later job of the pass would hit.
async function ashbyIds(
  deps: FetchDeps,
  org: string,
): Promise<{ ids: Set<string> | null; failed: boolean }> {
  try {
    // A whole-board listing, so the board cap (as boards/list.ts), not the single-page one.
    const res = await safeFetch(
      deps,
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}`,
      { maxBytes: BOARD_MAX_BYTES },
    );
    if (res.status !== 200) return { ids: null, failed: failedStatus(res.status) };
    const board = AshbyIds.safeParse(safeJson(res.body));
    return {
      ids: board.success ? new Set(board.data.jobs.map((j) => j.id.toLowerCase())) : null,
      failed: false,
    };
  } catch {
    return { ids: null, failed: true };
  }
}

export async function checkPosting(
  deps: FetchDeps,
  url: string,
  boards: BoardCache = new Map(),
): Promise<CheckResult> {
  const t = checkTarget(url);
  if (!t) return { liveness: "unavailable", failed: false, requested: false };
  const enc = encodeURIComponent;
  switch (t.ats) {
    case "greenhouse": {
      const res = await safeFetch(
        deps,
        `https://boards-api.greenhouse.io/v1/boards/${enc(t.board)}/jobs/${enc(t.postingId)}`,
      );
      return byStatus(res.status);
    }
    case "lever": {
      const res = await safeFetch(
        deps,
        `https://api.lever.co/v0/postings/${enc(t.company)}/${enc(t.postingId)}`,
      );
      return byStatus(res.status);
    }
    case "smartrecruiters": {
      const res = await safeFetch(
        deps,
        `https://api.smartrecruiters.com/v1/companies/${enc(t.company)}/postings/${enc(t.postingId)}`,
      );
      return byStatus(res.status);
    }
    case "ashby": {
      // A posting missing from a board that answered is closed; a board that didn't answer (even
      // a 404: the org may have moved) is unavailable.
      const key = t.org.toLowerCase();
      let board = boards.get(key);
      // Only the job that reads the board made a request (and reports it to the breaker).
      const requested = board === undefined;
      if (!board) {
        board = ashbyIds(deps, t.org);
        boards.set(key, board);
      }
      const { ids, failed } = await board;
      if (ids === null) return { liveness: "unavailable", failed, requested };
      return { liveness: ids.has(t.postingId) ? "open" : "closed", failed: false, requested };
    }
    default:
      return { liveness: "unavailable", failed: false, requested: false };
  }
}

export type CheckPassDeps = FetchDeps & {
  guard: PollGuard;
  store: {
    due: (now: Date) => Promise<JobToCheck[]>;
    record: (
      job: JobToCheck,
      outcome: PostingOutcome,
    ) => Promise<{ closedNow: boolean; reopenedNow: boolean }>;
  };
};

export type CheckPassSummary = {
  checked: number;
  open: number;
  closed: number;
  unavailable: number;
  heldBack: number;
  // Due jobs whose link has no API we can ask (EU Lever, say): no request was made.
  unchecked: number;
};

const errorName = (e: unknown) => (e instanceof Error ? e.name : "Error");

// One pass over the due jobs. Each ATS's `source:<ats>` kill switch and breaker (NS-147) decide
// whether its postings are read; a held-back job stays due. Never throws for one job (ADR-0007).
export async function checkPass(deps: CheckPassDeps, now: Date): Promise<CheckPassSummary> {
  const summary: CheckPassSummary = {
    checked: 0,
    open: 0,
    closed: 0,
    unavailable: 0,
    heldBack: 0,
    unchecked: 0,
  };
  const boards: BoardCache = new Map();
  for (const job of await deps.store.due(now)) {
    // A link we can't ask about (or whose ATS doesn't match the stored one) makes no request and
    // touches no breaker: it stays as it is.
    if (checkTarget(job.url)?.ats !== job.ats) {
      summary.unchecked++;
      // An attempt, so it drops back in line rather than taking the front of every pass.
      try {
        await deps.store.record(job, "unavailable");
      } catch {
        // Our database: the job stays due and the pass goes on.
      }
      continue;
    }
    const dependency = `source:${job.ats}`;
    let probeToken: string | null = null;
    try {
      if (!(await deps.guard.isOn(dependency))) {
        summary.heldBack++;
        continue;
      }
      const decision = await deps.guard.acquire(dependency);
      if (!decision.allowed) {
        summary.heldBack++;
        continue;
      }
      probeToken = decision.probe ? decision.probeToken : null;
    } catch {
      // Postgres down: no unguarded call goes out.
      summary.heldBack++;
      continue;
    }
    const outcome = await checkOne(deps, job, dependency, probeToken, boards);
    summary.checked++;
    summary[outcome]++;
  }
  return summary;
}

function checkOne(
  deps: CheckPassDeps,
  job: JobToCheck,
  dependency: string,
  probeToken: string | null,
  boards: BoardCache,
): Promise<Liveness> {
  return trace
    .getTracer("@northstar/sources")
    .startActiveSpan("source.posting_check", async (span): Promise<Liveness> => {
      // Ids and the ATS only, never the URL (it names the company Paul applied to).
      span.setAttributes({ "source.ats": job.ats, "northstar.job.id": job.jobId });
      const report = async (outcome: CallOutcome) => {
        try {
          await deps.guard.report(dependency, outcome, probeToken);
        } catch {
          span.setAttribute("source.breaker_report_failed", true);
        }
      };
      try {
        let result: CheckResult;
        try {
          result = await checkPosting(deps, job.url, boards);
        } catch (error) {
          // A refused or failed fetch: the ATS didn't answer.
          await report({ ok: false, error: errorName(error) });
          span.setStatus({ code: SpanStatusCode.ERROR, message: errorName(error) });
          result = { liveness: "unavailable", failed: true, requested: true };
          await deps.store.record(job, result.liveness);
          return result.liveness;
        }
        if (result.requested)
          await report(result.failed ? { ok: false, error: "Unavailable" } : { ok: true });
        span.setAttribute("source.liveness", result.liveness);
        // Every attempt is stored: an unavailable one moves the job back in line (it never
        // counts toward closing it), so a dead link can't stay first and take the whole pass.
        await deps.store.record(job, result.liveness);
        return result.liveness;
      } catch (error) {
        // Saving failed (our database): the job stays due and the pass goes on.
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorName(error) });
        return "unavailable";
      } finally {
        span.end();
      }
    });
}
