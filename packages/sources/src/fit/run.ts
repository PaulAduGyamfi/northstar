import type { FitScoreInput, Preferences, ScorableJob, ScoringProfile } from "@northstar/db";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { jobFingerprint, scoreJob } from "./score.js";

// One scoring pass (NS-116): every ready job with no score for the current preferences, resume
// import and job fields is scored and stored. Safe to repeat: a pass with nothing new does
// nothing, and two passes racing store one score per key (unique in the database).

export type ScoreStore = {
  preferences: () => Promise<Preferences | null>;
  profile: () => Promise<ScoringProfile | null>;
  jobs: () => Promise<ScorableJob[]>;
  // `<jobId>:<fingerprint>` already stored for this preference version and resume import.
  keys: (preferenceId: string, profileSourceId: string) => Promise<Set<string>>;
  save: (input: FitScoreInput) => Promise<"saved" | "exists">;
};

export type ScoreCounts = {
  jobs: number;
  queue: number;
  suggest: number;
  skip: number;
  failed: number;
};

export type ScoreRun =
  | { status: "no_profile" | "no_preferences" }
  | { status: "done"; preferences: Preferences; counts: ScoreCounts };

export function scorePending(store: ScoreStore): Promise<ScoreRun> {
  return trace
    .getTracer("@northstar/sources")
    .startActiveSpan("fit.score", async (span): Promise<ScoreRun> => {
      try {
        const [preferences, profile] = await Promise.all([store.preferences(), store.profile()]);
        if (!profile || !preferences) {
          const status = profile ? "no_preferences" : "no_profile";
          span.setAttribute("fit.outcome", status);
          return { status };
        }
        const keys = await store.keys(preferences.id, profile.sourceId);
        const counts: ScoreCounts = { jobs: 0, queue: 0, suggest: 0, skip: 0, failed: 0 };
        for (const job of await store.jobs()) {
          const fingerprint = jobFingerprint(job);
          if (keys.has(`${job.id}:${fingerprint}`)) continue;
          const fit = scoreJob(job, preferences, profile);
          try {
            const saved = await store.save({
              jobId: job.id,
              preferenceId: preferences.id,
              preferenceVersion: preferences.version,
              profileSourceId: profile.sourceId,
              jobFingerprint: fingerprint,
              ...fit,
              // Stored as plain JSON (jsonb).
              evidence: { ...fit.evidence },
            });
            // Another pass stored this key first: not counted twice.
            if (saved === "exists") continue;
            counts.jobs++;
            counts[fit.band]++;
          } catch {
            // One job that won't save fails alone; it is still pending, so the next pass retries.
            counts.failed++;
          }
        }
        span.setAttributes({
          "fit.outcome": "done",
          "fit.preference_version": preferences.version,
          "fit.jobs": counts.jobs,
          "fit.queue": counts.queue,
          "fit.suggest": counts.suggest,
          "fit.skip": counts.skip,
          "fit.failed": counts.failed,
        });
        return { status: "done", preferences, counts };
      } catch (error) {
        // Named, never quoted: a database error's detail can quote a row.
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.name : "Error",
        });
        throw error;
      } finally {
        span.end();
      }
    });
}

// Runs `action`, then a scoring pass, so new or edited jobs get their score straight away
// (used after `jobs add`, `jobs set` and every poll pass). Scoring problems never undo or fail
// the action: they are reported in the pass result, or as `error` when the pass threw.
export async function thenScore<T>(
  action: () => Promise<T>,
  score: () => Promise<ScoreRun>,
): Promise<{ result: T; scoring: ScoreRun | { status: "error"; errorName: string } }> {
  const result = await action();
  try {
    return { result, scoring: await score() };
  } catch (error) {
    return {
      result,
      scoring: { status: "error", errorName: error instanceof Error ? error.name : "Error" },
    };
  }
}
