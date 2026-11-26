import { APPLY_BROWSER_QUEUE, PIPELINE_QUEUE } from "./queues.js";

// Bounded concurrency per worker pool (NS-219, RES-009): how many tasks each queue's worker runs at
// once. A full pool leaves tasks waiting in Temporal's queue, so a burst backs up instead of
// opening many browsers or model calls at once; nothing is dropped. The worker process (#230)
// passes `workerOptions` to each Worker it starts. Only the queues that exist are listed; other
// domains' pools arrive with their queues.

export type PoolQueue = typeof PIPELINE_QUEUE | typeof APPLY_BROWSER_QUEUE;
export type PoolLimits = Record<PoolQueue, number>;

type PoolSetting = { name: string; fallback: number; ceiling: number };

const SETTINGS: Record<PoolQueue, PoolSetting> = {
  [PIPELINE_QUEUE]: { name: "WORKER_PIPELINE_CONCURRENCY", fallback: 4, ceiling: 16 },
  // One browser at a time unless Paul raises it. The claim ledger still allows one submission per
  // ATS and the 90 s gap whatever this says (ADR-0003, APPLY-007).
  [APPLY_BROWSER_QUEUE]: { name: "WORKER_APPLY_BROWSER_CONCURRENCY", fallback: 1, ceiling: 4 },
};

// Plain digits only: no sign, spaces, decimals or hex.
const WHOLE = /^[0-9]{1,3}$/;

function readLimit(settings: Record<string, string | undefined>, s: PoolSetting): number {
  const raw = settings[s.name];
  // Unset or empty: the default.
  if (raw === undefined || raw === "") return s.fallback;
  const n = WHOLE.test(raw) ? Number(raw) : Number.NaN;
  if (!(n >= 1 && n <= s.ceiling)) {
    // Names the setting and its range, never the value.
    throw new Error(`${s.name}: a whole number from 1 to ${s.ceiling}`);
  }
  return n;
}

// The one place the pool limits are read. Entry points pass their settings in; app code never
// reads the process environment (AGENTS.md).
export function loadPoolLimits(settings: Record<string, string | undefined>): PoolLimits {
  return {
    [PIPELINE_QUEUE]: readLimit(settings, SETTINGS[PIPELINE_QUEUE]),
    [APPLY_BROWSER_QUEUE]: readLimit(settings, SETTINGS[APPLY_BROWSER_QUEUE]),
  };
}

// The Temporal worker options for one pool: its queue and its limit. The limit that matters is
// on activities, where browsers and model calls run. Workflow tasks are short replays; Temporal
// raises a workflow-task limit under 2 to 2 while its workflow cache is on (@temporalio/worker
// 1.25, with a warning), so it is never asked for less. The worker process must not also pass a
// `tuner`: Temporal refuses both.
export function workerOptions(
  queue: PoolQueue,
  limits: PoolLimits,
): {
  taskQueue: PoolQueue;
  maxConcurrentActivityTaskExecutions: number;
  maxConcurrentWorkflowTaskExecutions: number;
} {
  return {
    taskQueue: queue,
    maxConcurrentActivityTaskExecutions: limits[queue],
    maxConcurrentWorkflowTaskExecutions: Math.max(2, limits[queue]),
  };
}
