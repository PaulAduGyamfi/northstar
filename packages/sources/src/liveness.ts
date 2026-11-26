import type { JobToCheck, PostingOutcome } from "@northstar/db";
import type { CallOutcome } from "@northstar/domain";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { z } from "zod";
import { detectAts } from "./ats/detect.js";
import { safeJson } from "./ats/greenhouse.js";
import { type FetchDeps, safeFetch } from "./fetch.js";
import type { PollGuard } from "./poll.js";

// Posting liveness (NS-173 slice 2, SRC-010): re-check a saved job's posting through the ATS's
// public API, one request per job, through safeFetch. "closed" only on the ATS's own answer that
// the posting is gone (a 404 for the posting, or absent from a board that answered); anything
// else (a refused fetch, a 5xx, a board that's gone) is "unavailable" and stores nothing, so a
// flaky board never closes a job.

export type Liveness = PostingOutcome | "unavailable";

const AshbyIds = z.object({ jobs: z.array(z.object({ id: z.string() })) });

const byStatus = (status: number): Liveness =>
  status === 200 ? "open" : status === 404 ? "closed" : "unavailable";

export async function checkPosting(deps: FetchDeps, url: string): Promise<Liveness> {
  const t = detectAts(url);
  if (!t) return "unavailable";
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
      // The whole board: a posting missing from a board that answered is closed; a board that
      // didn't answer (even a 404: the org may have moved) is unavailable.
      const res = await safeFetch(
        deps,
        `https://api.ashbyhq.com/posting-api/job-board/${enc(t.org)}`,
      );
      if (res.status !== 200) return "unavailable";
      const board = AshbyIds.safeParse(safeJson(res.body));
      if (!board.success) return "unavailable";
      return board.data.jobs.some((j) => j.id.toLowerCase() === t.postingId) ? "open" : "closed";
    }
    default:
      return "unavailable";
  }
}

export type CheckPassDeps = FetchDeps & {
  guard: PollGuard;
  store: {
    due: (now: Date) => Promise<JobToCheck[]>;
    record: (job: JobToCheck, outcome: PostingOutcome) => Promise<{ closedNow: boolean }>;
  };
};

export type CheckPassSummary = {
  checked: number;
  open: number;
  closed: number;
  unavailable: number;
  heldBack: number;
};

const errorName = (e: unknown) => (e instanceof Error ? e.name : "Error");

// One pass over the due jobs. Each ATS's `source:<ats>` kill switch and breaker (NS-147) decide
// whether its postings are read; a held-back job stays due. Never throws for one job (ADR-0007).
export async function checkPass(deps: CheckPassDeps, now: Date): Promise<CheckPassSummary> {
  const summary: CheckPassSummary = { checked: 0, open: 0, closed: 0, unavailable: 0, heldBack: 0 };
  for (const job of await deps.store.due(now)) {
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
    const outcome = await checkOne(deps, job, dependency, probeToken);
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
        let liveness: Liveness;
        try {
          liveness = await checkPosting(deps, job.url);
        } catch (error) {
          await report({ ok: false, error: errorName(error) });
          span.setStatus({ code: SpanStatusCode.ERROR, message: errorName(error) });
          return "unavailable";
        }
        // A 5xx or a malformed answer counts against the ATS; a 404 is it answering.
        await report(
          liveness === "unavailable" ? { ok: false, error: "Unavailable" } : { ok: true },
        );
        span.setAttribute("source.liveness", liveness);
        if (liveness !== "unavailable") await deps.store.record(job, liveness);
        return liveness;
      } catch (error) {
        // Saving failed (our database): the job stays due and the pass goes on.
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorName(error) });
        return "unavailable";
      } finally {
        span.end();
      }
    });
}
