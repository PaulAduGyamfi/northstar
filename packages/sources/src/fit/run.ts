import type { FitScoreInput, Preferences, ScorableJob, ScoringProfile } from "@northstar/db";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Unmatched } from "./match.js";
import type { ModelMatch } from "./model-match.js";
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
  // Optional model assist (NS-138): asked only about what the rules left unmatched, it returns
  // matches that already passed checkJobMatches (assistUnmatched). Absent unless the caller turns
  // the job-match route on.
  assist?: (unmatched: Unmatched[], profile: ScoringProfile) => Promise<AssistOutcome>;
};

export type AssistOutcome =
  | { kind: "assisted"; matches: ModelMatch[] }
  | { kind: "skipped" | "failed" };

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
        // Jobs the model was asked about and answered, and asks that failed (the rules score
        // was kept for those: an assist never blocks scoring, ADR-0007).
        let assisted = 0;
        let assistFailed = 0;
        for (const job of await store.jobs()) {
          const fingerprint = jobFingerprint(job);
          if (keys.has(`${job.id}:${fingerprint}`)) continue;
          let fit = scoreJob(job, preferences, profile);
          let method: FitScoreInput["method"] = "rules";
          if (store.assist && fit.evidence.unmatched.length > 0) {
            try {
              const a = await store.assist(fit.evidence.unmatched, profile);
              if (a.kind === "assisted") {
                assisted++;
                fit = scoreJob(job, preferences, profile, a.matches);
                if (fit.evidence.matched.some((m) => m.by === "model")) method = "rules_model";
              } else if (a.kind === "failed") assistFailed++;
            } catch (error) {
              // A transport error, breaker or timeout: the rules score stands. Named only.
              assistFailed++;
              lastError = error instanceof Error ? error.name : "Error";
            }
          }
          try {
            const saved = await store.save({
              jobId: job.id,
              preferenceId: preferences.id,
              preferenceVersion: preferences.version,
              profileSourceId: profile.sourceId,
              jobFingerprint: fingerprint,
              ...fit,
              method,
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
          // Only when an assist is configured: without one, the span is as NS-116 wrote it.
          ...(store.assist ? { "fit.assisted": assisted, "fit.assist_failed": assistFailed } : {}),
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
