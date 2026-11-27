import { type Db, listOpenDeadLetters, type PackageSignal } from "@northstar/db";
import { createTestDb, seedApplication } from "@northstar/db/testing";
import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TemporalPort } from "../client.js";
import { createRelayActivities } from "./relay.js";

// The package decision relay's activities (NS-213 slice 2) on a fake Temporal and fake reads;
// the dead letter on PGlite. Synthetic ids only.

const APP = "00000000-0000-4000-8000-0000000000a1";
const DECISION = "00000000-0000-4000-8000-0000000000d1";
const sha = (c: string) => c.repeat(64);
const id = (c: string) => `submission:${APP}:${sha(c)}`;

let db: Db;
let close: () => Promise<void>;
let candidateId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = (await seedApplication(db, "awaiting_approval")).candidateId;
});
afterEach(() => close());

// A Temporal whose runs are listed as waiting, decided, or (absent) not running.
function fakeTemporal(runs: Record<string, "waiting" | "decided">, endOnSignal = false) {
  const signals: unknown[] = [];
  const port: TemporalPort = {
    start: async () => ({ started: false }),
    async signal(workflowId, signal, args) {
      if (endOnSignal || runs[workflowId] === undefined) return { delivered: false };
      signals.push({ workflowId, signal, args });
      return { delivered: true };
    },
    waiting: async (workflowId) => runs[workflowId] === "waiting",
  };
  return { port, signals };
}

const approval = (c: string): PackageSignal => ({
  kind: "approval",
  applicationId: APP,
  packageSha256: sha(c),
  decisionId: DECISION,
});
const withdrawn = (c: string): PackageSignal => ({
  kind: "withdrawn",
  applicationId: APP,
  packageSha256: sha(c),
});

describe("the relayPackageDecisions activity", () => {
  it("sends each waiting run its outcome and skips runs that ended, decided or never started", async () => {
    const t = fakeTemporal({ [id("a")]: "waiting", [id("b")]: "waiting", [id("c")]: "decided" });
    const read = async () => [approval("a"), withdrawn("b"), approval("c"), withdrawn("d")];
    const activities = createRelayActivities(read, () => t.port, db);
    expect(await activities.relayPackageDecisions({ candidateId })).toEqual({
      signalled: 2,
      skipped: 2,
    });
    expect(t.signals).toEqual([
      { workflowId: id("a"), signal: "approval", args: [{ decisionId: DECISION }] },
      { workflowId: id("b"), signal: "withdrawn", args: [] },
    ]);
  });

  it("counts a run that ended between the check and the signal as skipped", async () => {
    const t = fakeTemporal({ [id("a")]: "waiting" }, true);
    const activities = createRelayActivities(
      async () => [approval("a")],
      () => t.port,
      db,
    );
    expect(await activities.relayPackageDecisions({ candidateId })).toEqual({
      signalled: 0,
      skipped: 1,
    });
  });

  it("reads the named candidate's outcomes", async () => {
    const seen: string[] = [];
    const t = fakeTemporal({});
    const read = async (c: CandidateId) => {
      seen.push(c);
      return [];
    };
    await createRelayActivities(read, () => t.port, db).relayPackageDecisions({ candidateId });
    expect(seen).toEqual([candidateId]);
  });

  it("lets a failed read or Temporal call through for the retry policy", async () => {
    const boom = new Error("database down");
    const t = fakeTemporal({});
    const failing = createRelayActivities(
      async () => {
        throw boom;
      },
      () => t.port,
      db,
    );
    await expect(failing.relayPackageDecisions({ candidateId })).rejects.toBe(boom);
  });

  it("refuses a candidate id that isn't a uuid, without retry, before reading", async () => {
    let called = false;
    const t = fakeTemporal({});
    const activities = createRelayActivities(
      async () => {
        called = true;
        return [];
      },
      () => t.port,
      db,
    );
    const failure = await activities
      .relayPackageDecisions({ candidateId: "nope" })
      .catch((error: unknown) => error);
    expect([failure, called]).toEqual([
      expect.objectContaining({ type: "InvalidInput", nonRetryable: true }),
      false,
    ]);
  });

  it("refuses, without retry, an outcome whose ids aren't ids", async () => {
    const t = fakeTemporal({ [`submission:${APP}:${sha("a")}`]: "waiting" });
    const bad = { ...approval("a"), decisionId: "nope" };
    const activities = createRelayActivities(
      async () => [bad],
      () => t.port,
      db,
    );
    const failure = await activities
      .relayPackageDecisions({ candidateId })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ type: "InvalidInput", nonRetryable: true });
  });
});

describe("the recordRelayFailure activity", () => {
  it("records a failed pass as one dead letter, even when called twice", async () => {
    const t = fakeTemporal({});
    const activities = createRelayActivities(
      async () => [],
      () => t.port,
      db,
    );
    const key = "signal_relay:00000000-0000-4000-8000-0000000000c1:7";
    await activities.recordRelayFailure({ candidateId, key });
    await activities.recordRelayFailure({ candidateId, key });
    expect(await listOpenDeadLetters(db, CandidateId.parse(candidateId))).toEqual([
      expect.objectContaining({
        kind: "apply.signal_relay",
        subject: `candidate:${candidateId}`,
        reasonCode: "relay_failed",
        attempts: 3,
      }),
    ]);
  });
});
