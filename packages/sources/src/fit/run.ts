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
        let lastError: string | null = null;
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
          } catch (error) {
            // One job that won't save fails alone; it is still pending, so the next pass retries.
            // Its error is kept by name only (a database error's detail can quote a row).
            counts.failed++;
            lastError = error instanceof Error ? error.name : "Error";
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
          ...(lastError ? { "fit.last_error": lastError } : {}),
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
