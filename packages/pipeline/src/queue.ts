import { countQueuedToday, createApplication, type Db, readQueueCandidates } from "@northstar/db";
import type { CandidateId } from "@northstar/domain";

// The queueing rule (NS-280 slice 1, MAT-003, APPLY-001): plain code, no model or network. A ready
// job whose newest Fit Score is in the queue band, with no application and an open posting,
// becomes a `queued` application started by Northstar, at most `dailyCap` a UTC day. Queueing
// submits nothing: the package step files with the Gate, and only an approval lets the Apply
// Gateway act (ADR-0002).

// APPLY-007's ceiling: the Apply Gateway sends at most 25 a day, so queueing more is waste.
export const MAX_QUEUE_DAILY_CAP = 25;

export type QueueResult = {
  // Applications this pass created.
  queued: number;
  // Already queued by an earlier pass or a racing one (the same idempotency key).
  replayed: number;
  // Candidates left for a later pass because the day's cap was reached.
  capped: number;
  // A job gone (deleted or another candidate's) between the read and the create.
  missing: number;
};

// The one key per job: a repeat, a retry or a racing pass replays the first application.
export const queueKey = (jobId: string): string => `job:${jobId}:queue`;

export async function queueReadyJobs(
  db: Db,
  candidateId: CandidateId,
  options: { dailyCap: number },
): Promise<QueueResult> {
  if (!Number.isInteger(options.dailyCap) || options.dailyCap < 1) {
    throw new RangeError("dailyCap must be a whole number of at least 1");
  }
  const cap = Math.min(options.dailyCap, MAX_QUEUE_DAILY_CAP);
  const result: QueueResult = { queued: 0, replayed: 0, capped: 0, missing: 0 };
  const candidates = await readQueueCandidates(db, candidateId);
  let room = Math.max(0, cap - (await countQueuedToday(db, candidateId)));
  for (const jobId of candidates) {
    if (room === 0) {
      result.capped++;
      continue;
    }
    const created = await createApplication(db, {
      candidateId,
      jobId,
      status: "queued",
      startedBy: "northstar",
      idempotencyKey: queueKey(jobId),
    });
    if (!created.ok) {
      // JobNotFound only: the key is per job and the status an entry one, so the others can't
      // happen here; counted, never thrown, so one job never stops the rest.
      result.missing++;
      continue;
    }
    if (created.value.replayed) result.replayed++;
    else {
      result.queued++;
      room--;
    }
  }
  return result;
}
