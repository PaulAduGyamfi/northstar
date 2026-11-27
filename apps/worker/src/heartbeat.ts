// The worker process's heartbeats (NS-225 slice 3, RES-013): every pool records a beat at start
// and every 30 s while the process runs, so Health shows a pool that stopped. A failed beat is
// only logged (by error class): the next one tries again, and a database down long enough shows
// as the pool not running, which is the honest reading.

export const HEARTBEAT_MS = 30_000;

export type Beat = { queue: "pipeline" | "apply-browser"; enabled: boolean; startedAt: Date };

export type HeartbeatDeps = {
  record: (beat: Beat) => Promise<void>;
  // setInterval / clearInterval; tests pass fake timers.
  every: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  onError: (errorClass: string) => void;
};

// Starts beating for each pool; `stop` ends it. Beats never overlap: a beat still in flight
// when the next is due is skipped.
export function startHeartbeats(beats: readonly Beat[], deps: HeartbeatDeps): { stop: () => void } {
  let inFlight = false;
  const beatAll = () => {
    if (inFlight) return;
    inFlight = true;
    void Promise.all(
      beats.map((b) =>
        deps.record(b).catch((error: unknown) => {
          // The class name only, kept to a plain identifier: a library that ever put free text
          // in `name` still can't reach the log.
          const name = error instanceof Error ? error.name : "";
          deps.onError(/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "unknown");
        }),
      ),
    ).finally(() => {
      inFlight = false;
    });
  };
  beatAll();
  const handle = deps.every(beatAll, HEARTBEAT_MS);
  return { stop: () => deps.cancel(handle) };
}
