import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { greenhouse } from "../adapters/greenhouse.js";
import { type BrowserLauncher, launchFormDriver } from "./launch.js";
import { fakePage } from "./test/page.js";

// Starting the browser (NS-142) with a fake launcher: no browser runs in these tests.

function fakeLauncher(failNewPage = false) {
  const calls: string[] = [];
  const options: unknown[] = [];
  const launcher: BrowserLauncher = {
    launch: async (o) => {
      calls.push("launch");
      options.push(o);
      return {
        newContext: async (c) => {
          calls.push("newContext");
          options.push(c);
          return {
            newPage: async () => {
              calls.push("newPage");
              if (failNewPage) throw new Error("page crashed");
              return fakePage({ pages: {} });
            },
          };
        },
        close: async () => {
          calls.push("browser.close");
        },
      };
    },
  };
  return { launcher, calls, options };
}

describe("launchFormDriver", () => {
  it("starts headless Chromium with a fresh context, downloads off and service workers blocked", async () => {
    const { launcher, calls, options } = fakeLauncher();
    await launchFormDriver(
      { hosts: greenhouse.hosts, executablePath: "/opt/browsers/chromium" },
      launcher,
    );
    expect([calls, options]).toEqual([
      ["launch", "newContext", "newPage"],
      [
        { headless: true, executablePath: "/opt/browsers/chromium" },
        { acceptDownloads: false, serviceWorkers: "block" },
      ],
    ]);
  });

  it("leaves the executable to playwright-core when none is given", async () => {
    const { launcher, options } = fakeLauncher();
    await launchFormDriver({ hosts: greenhouse.hosts }, launcher);
    expect(options[0]).toEqual({ headless: true });
  });

  it("closes the whole browser at once when the driver closes", async () => {
    const { launcher, calls } = fakeLauncher();
    const driver = await launchFormDriver({ hosts: greenhouse.hosts }, launcher);
    await driver.close();
    expect(calls.slice(3)).toEqual(["browser.close"]);
  });

  it("is the only file in the package that imports playwright-core", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const importers = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => /from\s+["']playwright-core["']/.test(readFileSync(join(root, f), "utf8")));
    expect(importers).toEqual([join("apply", "browser", "launch.ts")]);
  });

  it("closes the browser when it can't open a page", async () => {
    const { launcher, calls } = fakeLauncher(true);
    await expect(launchFormDriver({ hosts: greenhouse.hosts }, launcher)).rejects.toThrow(
      "page crashed",
    );
    expect(calls).toEqual(["launch", "newContext", "newPage", "browser.close"]);
  });
});
