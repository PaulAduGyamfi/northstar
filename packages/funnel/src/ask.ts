import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

// Paul's answers for `funnel review`, one line at a time. Closed input (Ctrl-D, Ctrl-C, or a
// shell that gives no keyboard, such as Claude Code's `!` commands) settles the waiting question
// as null, so the review ends cleanly instead of hanging. The same pattern as `profile interview`.
export function createAsker(io: { input: Readable; output: Writable }) {
  const rl = createInterface({ input: io.input, output: io.output });
  const stop = new AbortController();
  rl.on("close", () => stop.abort());
  // Without a listener, Ctrl-C only pauses readline and a pending question would hang.
  rl.on("SIGINT", () => rl.close());
  return {
    question: async (prompt: string): Promise<string | null> => {
      if (stop.signal.aborted) return null;
      try {
        return await rl.question(prompt, { signal: stop.signal });
      } catch {
        return null;
      }
    },
    close: () => rl.close(),
  };
}
