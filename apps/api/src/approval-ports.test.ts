import { randomUUID } from "node:crypto";
import { type Db, requestApproval } from "@northstar/db";
import { createTestDb, seedApplication, setGateClock } from "@northstar/db/testing";
import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbApprovalPorts } from "./approval-ports.js";

// The approval queue's ports on the Gate's real write paths (NS-139), PGlite. Synthetic subjects.
const NOW = new Date("2026-11-25T12:00:00Z");

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = CandidateId.parse((await seedApplication(db, "awaiting_approval")).candidateId);
  await setGateClock(db, NOW);
});

afterEach(async () => {
  await close();
});

async function pending(kind: "answer" | "outreach"): Promise<string> {
  const r = await requestApproval(db, {
    candidateId,
    kind,
    subject: `${kind}:${randomUUID()}`,
    contentSha256: "c".repeat(64),
    facts: null,
    actor: "agent:answers",
    idempotencyKey: randomUUID(),
  });
  if (!r.ok) throw new Error(r.error.kind);
  return r.value.requestId;
}

describe("dbApprovalPorts", () => {
  it("lists the queue, decides as Paul, and the decided item leaves the queue", async () => {
    const ports = dbApprovalPorts(db, async () => candidateId);
    const a = await pending("answer");
    const b = await pending("outreach");
    // The Gate's clock is pinned, so both share a time and the queue orders them by id.
    expect((await ports.list(undefined)).map((p) => p.requestId).sort()).toEqual([a, b].sort());
    expect((await ports.list("outreach")).map((p) => p.requestId)).toEqual([b]);

    const decided = await ports.decide({ requestIds: [a], decision: "approve" });
    // The Gate's view of the stored decision row: recorded as Paul's.
    const view = decided.ok ? decided.value[0]?.result : undefined;
    expect(view?.ok && [view.value.decision, view.value.decidedBy]).toEqual(["approved", "user"]);
    expect((await ports.list(undefined)).map((p) => p.requestId)).toEqual([b]);
  });

  it("an undo inside the window puts the item back in the queue", async () => {
    const ports = dbApprovalPorts(db, async () => candidateId);
    const a = await pending("answer");
    const decided = await ports.decide({ requestIds: [a], decision: "approve" });
    const view = decided.ok ? decided.value[0]?.result : undefined;
    if (!view?.ok) throw new Error("not decided");
    expect(await ports.undo(view.value.decisionId)).toEqual({ ok: true, value: { requestId: a } });
    expect((await ports.list(undefined)).map((p) => p.requestId)).toEqual([a]);
  });
});
