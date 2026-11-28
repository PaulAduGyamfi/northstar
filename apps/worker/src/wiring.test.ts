import type { Db } from "@northstar/db";
import { CandidateId } from "@northstar/domain";
import type { FormDriver } from "@northstar/gateways";
import { describe, expect, it, vi } from "vitest";
import { loadWorkerConfig } from "./config.js";
import { browserPorts, workerActivities } from "./wiring.js";

// Temporal's activity context, faked: the default heartbeat binding must call it with the step.
const heartbeats = vi.hoisted(() => [] as unknown[]);
vi.mock("@temporalio/activity", () => ({
  Context: { current: () => ({ heartbeat: (details: unknown) => heartbeats.push(details) }) },
}));

// Each pool gets only its own activities (NS-225, RES-001). Binding touches neither the database
// nor a browser, so a stand-in database is enough here.
const db = {} as Db;
const launch = async () => {
  throw new Error("no browser in tests");
};

describe("workerActivities", () => {
  it("gives the pipeline pool the ending, sweep, relay, notifier and job pipeline activities, and no browser pool while it is off", () => {
    const pools = workerActivities(db, loadWorkerConfig({}), launch);
    expect([Object.keys(pools.pipeline).sort(), pools.applyBrowser]).toEqual([
      [
        "notifyHandoffs",
        "preparePackage",
        "readJobForm",
        "recordNotifyFailure",
        "recordPipelineEnding",
        "recordRelayFailure",
        "recordSubmissionEnding",
        "recordSweepFailure",
        "relayPackageDecisions",
        "startSubmission",
        "sweepStaleClaims",
        "tailorResume",
      ],
      null,
    ]);
  });

  it("gives the browser pool only the submit activity once Paul turns it on", () => {
    const pools = workerActivities(
      db,
      loadWorkerConfig({
        WORKER_APPLY_BROWSER: "on",
        WORKER_CHROMIUM_PATH: "/opt/chromium/chrome",
      }),
      launch,
    );
    expect(Object.keys(pools.applyBrowser ?? {})).toEqual(["submitApplication"]);
  });
});

describe("browserPorts", () => {
  const CANDIDATE = CandidateId.parse("00000000-0000-4000-8000-0000000000c1");

  it("reads a file as the submission's own candidate", async () => {
    const asked: unknown[] = [];
    const ports = browserPorts(CANDIDATE, "/opt/chromium/chrome", {
      readFile: async (c, sha256) => {
        asked.push([c, sha256]);
        return null;
      },
      launch,
    });
    await ports.readFile("a".repeat(64));
    expect(asked).toEqual([[CANDIDATE, "a".repeat(64)]]);
  });

  it("starts the installed Chromium bound to the adapter's hosts, only on the form's first open", async () => {
    const launches: unknown[] = [];
    const page = { kind: "challenge", challenge: "captcha" } as const;
    const fake: FormDriver = {
      open: async () => page,
      fillAndSubmit: async () => page,
      close: async () => {},
    };
    const ports = browserPorts(CANDIDATE, "/opt/chromium/chrome", {
      readFile: async () => null,
      launch: async (options) => {
        launches.push(options);
        return fake;
      },
    });
    const driver = ports.openDriver(["boards.greenhouse.io"]);
    expect(launches).toEqual([]);
    await driver.open("https://boards.greenhouse.io/example/jobs/1");
    expect(launches).toEqual([
      { hosts: ["boards.greenhouse.io"], executablePath: "/opt/chromium/chrome" },
    ]);
  });
});

describe("the browser pool's default heartbeat (NS-225 slice 4)", () => {
  it("sends Temporal's activity heartbeat with the step name", async () => {
    heartbeats.length = 0;
    const pools = workerActivities(
      db,
      loadWorkerConfig({
        WORKER_APPLY_BROWSER: "on",
        WORKER_CHROMIUM_PATH: "/opt/chromium/chrome",
      }),
      launch,
    );
    // The stand-in database fails the package read; the first beat has gone out by then.
    await pools.applyBrowser
      ?.submitApplication({
        candidateId: "00000000-0000-4000-8000-000000000001",
        applicationId: "00000000-0000-4000-8000-0000000000a1",
        decisionId: "00000000-0000-4000-8000-0000000000d1",
        packageSha256: "b".repeat(64),
      })
      .catch(() => {});
    expect(heartbeats).toEqual(["load"]);
  });
});
