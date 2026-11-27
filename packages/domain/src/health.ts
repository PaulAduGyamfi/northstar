import type { BreakerState } from "./breaker.js";

// The health model (RES-013): every subsystem is healthy, degraded or down, with a reason in
// plain words. Pure code over state other packages store: breakers and kill switches (NS-126)
// and board watches (NS-115). packages/db reads that state and calls systemHealth.

export type Health = "healthy" | "degraded" | "down";

export type HealthInput = {
  breakers: (BreakerState & { dependency: string })[];
  switches: { subsystem: string; enabled: boolean; actor: string; reason: string }[];
  // Board watches by id and ATS only: a board's name never goes into a status line.
  watches: { id: string; ats: string; status: string; consecutiveFailures: number }[];
  // The worker process's pools (NS-225 slice 3): each queue's last heartbeat, as seconds before
  // the database's now, and whether the pool was turned on. Absent before any worker ran.
  workers?: { queue: string; enabled: boolean; secondsSinceSeen: number }[];
};

export type SubsystemHealth = {
  subsystem: string;
  kind: "dependency" | "switch" | "board" | "worker";
  health: Health;
  reason: string;
  // When a paused dependency will be tried again; null otherwise.
  retryAt: Date | null;
};

export type SystemHealth = { overall: Health; subsystems: SubsystemHealth[] };

// Breakers store an error name only, but this text ends up on screen: show it only when it is
// a plain identifier (TimeoutError, RateLimited), never anything that looks like a message.
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function fromBreaker(b: HealthInput["breakers"][number]): SubsystemHealth {
  const base = { subsystem: b.dependency, kind: "dependency" as const, retryAt: b.retryAt };
  if (b.status === "open") {
    const error = b.lastError && ERROR_NAME.test(b.lastError) ? ` (${b.lastError})` : "";
    return { ...base, health: "down", reason: `Paused after repeated failures${error}` };
  }
  if (b.status === "half_open") {
    // half_open retryAt is when the probe counts as lost, not a retry time: not shown.
    return {
      ...base,
      health: "degraded",
      reason: "Recovering: one test call allowed",
      retryAt: null,
    };
  }
  return { ...base, health: "healthy", reason: "Working", retryAt: null };
}

function fromSwitch(s: HealthInput["switches"][number]): SubsystemHealth {
  const base = { subsystem: s.subsystem, kind: "switch" as const, retryAt: null };
  if (s.enabled) return { ...base, health: "healthy", reason: "Switched on" };
  // A switched-off subsystem isn't running, so it is down, by choice (spec open question).
  const who = s.actor === "user" ? "you" : "Northstar";
  const why = s.reason.trim() === "" ? "" : `: ${s.reason.trim()}`;
  return { ...base, health: "down", reason: `Switched off by ${who}${why}` };
}

function fromWatch(w: HealthInput["watches"][number]): SubsystemHealth {
  const base = { subsystem: `board:${w.ats}:${w.id}`, kind: "board" as const, retryAt: null };
  const n = w.consecutiveFailures;
  if (w.status === "quarantined") {
    return {
      ...base,
      health: "degraded",
      reason: `Quarantined after ${n} failed reads; put it back with jobs watch retry`,
    };
  }
  if (w.status === "backing_off") {
    return { ...base, health: "degraded", reason: `Backing off after ${n} failed reads` };
  }
  return { ...base, health: "healthy", reason: "Reading" };
}

// A pool beats every 30 s (apps/worker); three minutes of silence means it isn't running.
export const WORKER_STALE_SECONDS = 180;

// Plain words for how long ago, in whole minutes once past one.
function ago(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "under a minute ago";
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  return `${Math.floor(minutes / 60)} hours ago`;
}

function fromWorker(w: NonNullable<HealthInput["workers"]>[number]): SubsystemHealth {
  const base = { subsystem: `worker:${w.queue}`, kind: "worker" as const, retryAt: null };
  // Turned off by Paul's setting (WORKER_APPLY_BROWSER): not a fault, so not a red mark.
  if (!w.enabled)
    return { ...base, health: "healthy", reason: "Turned off in the worker's settings" };
  if (w.secondsSinceSeen > WORKER_STALE_SECONDS) {
    return { ...base, health: "down", reason: `Not running: last seen ${ago(w.secondsSinceSeen)}` };
  }
  return { ...base, health: "healthy", reason: "Running" };
}

const RANK: Record<Health, number> = { down: 0, degraded: 1, healthy: 2 };

export function systemHealth(input: HealthInput): SystemHealth {
  const subsystems = [
    ...input.breakers.map(fromBreaker),
    ...input.switches.map(fromSwitch),
    ...input.watches.map(fromWatch),
    ...(input.workers ?? []).map(fromWorker),
  ].sort((a, b) => RANK[a.health] - RANK[b.health] || a.subsystem.localeCompare(b.subsystem));
  // One subsystem down never makes the whole system "down" (ADR-0007: the rest keeps working).
  // Overall "down" means the state can't be read at all, which the reader reports by throwing.
  const overall: Health = subsystems.every((s) => s.health === "healthy") ? "healthy" : "degraded";
  return { overall, subsystems };
}
