// Runs the worker pools together and stops them together (NS-225). Plain code over a small
// interface, so it is tested with fakes; main.ts passes Temporal's Workers.
//
// A pool must never be silently down while another runs: when one pool's run fails, every other
// pool is shut down, and the first failure is the one rethrown (not a later error from stopping).
// Temporal's NativeConnection can't close while any Worker still holds it, so main.ts closes it
// only after this returns.

export type Pool = {
  run(): Promise<void>;
  shutdown(): void;
};

export async function runPools(pools: readonly Pool[]): Promise<void> {
  let failure: { error: unknown } | null = null;
  const stopOthers = (except: Pool | null) => {
    for (const p of pools) {
      if (p === except) continue;
      try {
        p.shutdown();
      } catch {
        // Already stopping or stopped: nothing more to do for it.
      }
    }
  };
  await Promise.allSettled(
    pools.map((p) =>
      p.run().catch((error: unknown) => {
        failure ??= { error };
        stopOthers(p);
      }),
    ),
  );
  if (failure !== null) throw (failure as { error: unknown }).error;
}

// Stops pools that were created but never run (a later pool's creation failed), so they let go of
// the connection: each is started and shut down at once.
export async function stopPools(pools: readonly Pool[]): Promise<void> {
  await Promise.allSettled(
    pools.map((p) => {
      const running = p.run();
      try {
        p.shutdown();
      } catch {
        // Nothing to stop.
      }
      return running;
    }),
  );
}
