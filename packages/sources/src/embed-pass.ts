import { createHash } from "node:crypto";
import type { EmbeddableJob } from "@northstar/db";
import { trace } from "@opentelemetry/api";
import type { SuggestResult } from "./dupes.js";
import { embeddingText } from "./embedding-text.js";

// One embedding pass (NS-129 slice 3, SRC-006, ADR-0033). It runs after a scoring pass while
// JOB_EMBEDDINGS=on: it embeds the ready, open jobs whose text changed since their newest stored
// vector, in one request, stores each vector and asks for duplicate suggestions for each new one.
// Plain code with ports, so tests run with no database or network.

// One request's worth, the client's own batch limit: a pass is one call to OpenAI at most.
export const MAX_JOBS_PER_EMBED_PASS = 64;

export type EmbedPassDeps = {
  // Freshest first, so a pass that has more than it can embed takes the newest jobs.
  jobs: () => Promise<EmbeddableJob[]>;
  hashes: (jobIds: string[]) => Promise<Map<string, string>>;
  embed: (texts: readonly string[]) => Promise<number[][]>;
  save: (
    jobId: string,
    textSha256: string,
    embedding: number[],
  ) => Promise<"stored" | "unchanged" | "refused">;
  suggest: (jobId: string) => Promise<SuggestResult>;
};

export type EmbedPassReport = {
  // Jobs whose text changed (or that had no vector), and how many of them this pass took.
  pending: number;
  embedded: number;
  // Saves that stored nothing (the same text, or the job left `ready` meanwhile).
  unchanged: number;
  refused: number;
  suggested: number;
  // Jobs whose suggestion step threw. Their vector is stored, so a job embedded later still finds
  // them, but their pairs with jobs embedded earlier aren't retried until their text changes.
  suggestFailed: number;
  // The error's class when the request didn't go out or failed (held back, the API down): nothing
  // was stored, and the next pass retries the same jobs.
  stoppedBy: string | null;
};

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export function embedPass(deps: EmbedPassDeps): Promise<EmbedPassReport> {
  return trace
    .getTracer("@northstar/sources")
    .startActiveSpan("jobs.embed_pass", async (span): Promise<EmbedPassReport> => {
      const report: EmbedPassReport = {
        pending: 0,
        embedded: 0,
        unchanged: 0,
        refused: 0,
        suggested: 0,
        suggestFailed: 0,
        stoppedBy: null,
      };
      try {
        const candidates = (await deps.jobs()).flatMap((job) => {
          const text = embeddingText(job);
          return text === null ? [] : [{ jobId: job.jobId, text, textSha256: sha256(text) }];
        });
        const stored = await deps.hashes(candidates.map((c) => c.jobId));
        const pending = candidates.filter((c) => stored.get(c.jobId) !== c.textSha256);
        report.pending = pending.length;
        const batch = pending.slice(0, MAX_JOBS_PER_EMBED_PASS);
        if (batch.length === 0) return report;
        let vectors: number[][];
        try {
          vectors = await deps.embed(batch.map((b) => b.text));
        } catch (error) {
          // The class only: a message could quote the request.
          report.stoppedBy = error instanceof Error ? error.name : "UnknownError";
          return report;
        }
        const fresh: string[] = [];
        for (const [i, item] of batch.entries()) {
          const vector = vectors[i];
          // The client checks one vector per text; this only keeps the types honest.
          if (vector === undefined) throw new Error("embed returned fewer vectors than texts");
          const status = await deps.save(item.jobId, item.textSha256, vector);
          if (status === "stored") {
            report.embedded++;
            fresh.push(item.jobId);
          } else if (status === "unchanged") report.unchanged++;
          else report.refused++;
        }
        // After every vector of the batch is stored, so two new duplicates find each other.
        for (const jobId of fresh) {
          try {
            report.suggested += (await deps.suggest(jobId)).suggested;
          } catch {
            report.suggestFailed++;
          }
        }
        return report;
      } finally {
        span.setAttributes({
          "northstar.embed.pending": report.pending,
          "northstar.embed.embedded": report.embedded,
          "northstar.embed.suggested": report.suggested,
          "northstar.embed.suggest_failed": report.suggestFailed,
          "northstar.embed.unchanged": report.unchanged,
          "northstar.embed.refused": report.refused,
          ...(report.stoppedBy === null ? {} : { "northstar.embed.stopped_by": report.stoppedBy }),
        });
        span.end();
      }
    });
}

// Runs a pass after scoring and says what happened in one line. Never throws: embeddings are a
// suggestion step, so a failure (the database, the API, the spend cap) never fails the scoring
// command, and the next pass retries the same jobs.
export async function embedAfterScore(
  pass: () => Promise<EmbedPassReport>,
  print: (line: string) => void,
): Promise<void> {
  let report: EmbedPassReport;
  try {
    report = await pass();
  } catch (error) {
    print(
      `Job embeddings didn't run (${error instanceof Error ? error.name : "Error"}); the next pass retries.`,
    );
    return;
  }
  if (report.stoppedBy !== null) {
    print(`Job embeddings didn't run (${report.stoppedBy}); the next pass retries.`);
    return;
  }
  if (report.embedded === 0 && report.suggestFailed === 0 && report.refused === 0) return;
  const left = report.pending - report.embedded - report.unchanged - report.refused;
  print(
    `Embedded ${report.embedded} job${report.embedded === 1 ? "" : "s"}` +
      `${left > 0 ? ` (${left} more next pass)` : ""}; ` +
      `${report.suggested} possible duplicate${report.suggested === 1 ? "" : "s"}` +
      `${report.suggested > 0 ? " (see jobs dupes)" : ""}` +
      `${report.suggestFailed > 0 ? `; ${report.suggestFailed} couldn't be compared` : ""}` +
      // A refused save (the job left `ready` meanwhile) is sent again next pass, so say so.
      `${report.refused > 0 ? `; ${report.refused} not stored (no longer ready)` : ""}.`,
  );
}
