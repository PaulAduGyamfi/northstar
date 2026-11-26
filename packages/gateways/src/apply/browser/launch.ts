import { chromium } from "playwright-core";
import type { FormDriver } from "../driver.js";
import { createPlaywrightDriver, type DriverPage } from "./driver.js";

// Starts one browser for one submission (NS-142, ADR-0028): headless Chromium through
// playwright-core, which downloads no browser of its own, so the worker gives it the installed
// one (`executablePath`). A fresh context each time: no cookies from another submission,
// downloads off, service workers blocked. The default user agent, no stealth plugin and no
// fingerprint changes (ADR-0003). The driver's `close()` closes the browser.

// The members of playwright-core's `chromium` this uses, so a test can pass a fake.
export type BrowserLauncher = {
  launch(options: { headless: boolean; executablePath?: string }): Promise<{
    newContext(options: { acceptDownloads: boolean; serviceWorkers: "block" }): Promise<{
      newPage(): Promise<DriverPage>;
    }>;
    close(): Promise<void>;
  }>;
};

export type LaunchOptions = {
  // The adapter's own hosts (`AtsAdapter.hosts`).
  hosts: readonly string[];
  // The installed Chromium; playwright-core's own lookup when absent.
  executablePath?: string;
  stepTimeoutMs?: number;
};

export async function launchFormDriver(
  options: LaunchOptions,
  launcher: BrowserLauncher = chromium,
): Promise<FormDriver> {
  const browser = await launcher.launch({
    headless: true,
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
  });
  try {
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    const page = await context.newPage();
    return createPlaywrightDriver({
      page,
      hosts: options.hosts,
      ...(options.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: options.stepTimeoutMs }),
      // Closing the browser closes its context and every page at once: a context close that
      // hangs can't keep a click waiting behind it.
      onClose: () => browser.close(),
    });
  } catch (error) {
    // A browser that started but couldn't open a page must not be left running.
    await browser.close().catch(() => {});
    throw error;
  }
}
