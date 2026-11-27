import type { Fill, FormDriver, PageState, Upload } from "../driver.js";
import { DriverError } from "./driver.js";

// A FormDriver the Apply Gateway can take at once, which starts the browser only on its first
// `open` (NS-225). The gateway asks for a driver synchronously (`openDriver(hosts)`), while
// starting Chromium takes time and can fail; this wrapper does the launch inside the first step,
// where the gateway's own time limit and handoff already apply. After `close()` it takes no
// further browser action (ADR-0028): a close before `open` launches nothing, and a close while the
// browser is starting closes it as soon as it is up.

// Starts one browser session (launchFormDriver bound to its hosts and the installed Chromium).
export type LaunchDriver = () => Promise<FormDriver>;

export function deferredFormDriver(launch: LaunchDriver): FormDriver {
  let driver: Promise<FormDriver> | null = null;
  let closed = false;

  // The started driver, launching it on the first call. A close that landed while it was
  // starting fails the step, so a late browser never opens a page; that close (below) waits for
  // the launch and closes the browser itself.
  const started = async (): Promise<FormDriver> => {
    if (closed) throw new DriverError("the driver is closed");
    // A browser that won't start is this machine's trouble, never the ATS's: as a DriverError it
    // never counts against the ATS's breaker (only a step timeout does), even when the launch
    // itself timed out. Only the error's class name, never its message.
    driver ??= launch().catch((error: unknown) => {
      const name = error instanceof Error ? error.name : "unknown";
      throw new DriverError(`the browser didn't start (${name})`);
    });
    const d = await driver;
    if (closed) throw new DriverError("the driver closed while the browser was starting");
    return d;
  };

  return {
    async open(url: string): Promise<PageState> {
      return (await started()).open(url);
    },
    async fillAndSubmit(fills: readonly Fill[], uploads: readonly Upload[]): Promise<PageState> {
      // Never the first step: nothing is launched for a submit without an open page.
      if (driver === null) throw new DriverError("no page is open");
      return (await started()).fillAndSubmit(fills, uploads);
    },
    async close(): Promise<void> {
      closed = true;
      // Nothing started: nothing to close. A launch that failed left nothing running.
      if (driver === null) return;
      const d = await driver.catch(() => null);
      await d?.close();
    },
  };
}
