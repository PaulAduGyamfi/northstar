import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applicationPackage } from "./application-package-schema.js";
import {
  decideApprovals,
  requestApproval,
  undoDecision,
  withdrawApproval,
} from "./approval-write.js";
import type { Db } from "./db.js";
import { readPackageSignals } from "./package-signal-read.js";
import { createTestDb, seedApplication, setGateClock } from "./test/pglite.js";

// The relay's read of settled package outcomes (NS-213 slice 2), on PGlite. Synthetic ids only.

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let applicationId: string;

const T0 = new Date("2026-11-20T10:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const sha = (c: string) => c.repeat(64);

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "awaiting_approval");
  candidateId = CandidateId.parse(seeded.candidateId);
  applicationId = seeded.applicationId;
  await setGateClock(db, T0);
});
afterEach(() => close());

// One filed package round: the Gate request and its stored package, as requestPackageApproval
// leaves them. Returns the request id.
async function fileRound(hash: string): Promise<string> {
  const filed = await requestApproval(db, {
    candidateId,
    kind: "application_package",
    subject: `application_package:${hash.slice(0, 8)}-0000-4000-8000-000000000001`,
    contentSha256: hash,
    facts: null,
    actor: "system",
    idempotencyKey: `package:${hash}`,
  });
  if (!filed.ok) throw new Error(filed.error.kind);
  await db.insert(applicationPackage).values({
    candidateId,
    requestId: filed.value.requestId,
    applicationId,
    contentSha256: hash,
    package: { synthetic: true } as never,
  });
  return filed.value.requestId;
}

async function decide(requestId: string, decision: "approve" | "reject"): Promise<string> {
  const d = await decideApprovals(db, {
    candidateId,
    requestIds: [requestId],
    decision,
    ...(decision === "reject" ? { reason: "Not this one" } : {}),
  } as Parameters<typeof decideApprovals>[1]);
  const outcome = d.ok ? d.value[0]?.result : undefined;
  if (!outcome?.ok) throw new Error("not decided");
  return outcome.value.decisionId;
}

describe("readPackageSignals", () => {
  it("leaves out a decision inside its undo window, then relays the approval once it takes effect", async () => {
    const requestId = await fileRound(sha("a"));
    const decisionId = await decide(requestId, "approve");
    expect(await readPackageSignals(db, candidateId)).toEqual([]);
    await setGateClock(db, minutes(3));
    expect(await readPackageSignals(db, candidateId)).toEqual([
      { kind: "approval", applicationId, packageSha256: sha("a"), decisionId },
    ]);
  });

  it("relays an effective rejection and a withdrawal as withdrawn", async () => {
    const rejected = await fileRound(sha("b"));
    await decide(rejected, "reject");
    const withdrawn = await fileRound(sha("c"));
    await withdrawApproval(db, { candidateId, requestId: withdrawn, by: "user" });
    await setGateClock(db, minutes(3));
    const signals = await readPackageSignals(db, candidateId);
    expect(signals).toHaveLength(2);
    expect(signals).toEqual(
      expect.arrayContaining([
        { kind: "withdrawn", applicationId, packageSha256: sha("b") },
        { kind: "withdrawn", applicationId, packageSha256: sha("c") },
      ]),
    );
  });

  it("relays an approval withdrawn after it took effect as withdrawn", async () => {
    const requestId = await fileRound(sha("9"));
    await decide(requestId, "approve");
    await setGateClock(db, minutes(3));
    await withdrawApproval(db, { candidateId, requestId, by: "user" });
    expect(await readPackageSignals(db, candidateId)).toEqual([
      { kind: "withdrawn", applicationId, packageSha256: sha("9") },
    ]);
  });

  it("never relays an undone decision, and relays the new one once it takes effect", async () => {
    const requestId = await fileRound(sha("d"));
    const first = await decide(requestId, "approve");
    await undoDecision(db, { candidateId, decisionId: first });
    await setGateClock(db, minutes(3));
    expect(await readPackageSignals(db, candidateId)).toEqual([]);
    const second = await decide(requestId, "approve");
    await setGateClock(db, minutes(6));
    expect(await readPackageSignals(db, candidateId)).toEqual([
      { kind: "approval", applicationId, packageSha256: sha("d"), decisionId: second },
    ]);
  });

  it("leaves out a request still waiting for a decision", async () => {
    await fileRound(sha("e"));
    await setGateClock(db, minutes(3));
    expect(await readPackageSignals(db, candidateId)).toEqual([]);
  });

  it("leaves out an outcome older than the window", async () => {
    await decide(await fileRound(sha("f")), "approve");
    await setGateClock(db, minutes(8 * 24 * 60));
    expect(await readPackageSignals(db, candidateId)).toEqual([]);
  });

  it("gives another candidate none of this candidate's outcomes", async () => {
    const decisionId = await decide(await fileRound(sha("1")), "approve");
    await setGateClock(db, minutes(3));
    const other = await seedApplication(db, "awaiting_approval");
    expect([
      await readPackageSignals(db, CandidateId.parse(other.candidateId)),
      await readPackageSignals(db, candidateId),
    ]).toEqual([[], [{ kind: "approval", applicationId, packageSha256: sha("1"), decisionId }]]);
  });

  it("leaves out an approval of another kind of request", async () => {
    const reply = await requestApproval(db, {
      candidateId,
      kind: "email_reply",
      subject: "email:00000000-0000-4000-8000-0000000000e1",
      contentSha256: sha("2"),
      facts: null,
      actor: "system",
      idempotencyKey: "reply:0001",
    });
    if (!reply.ok) throw new Error(reply.error.kind);
    await decide(reply.value.requestId, "approve");
    await setGateClock(db, minutes(3));
    expect(await readPackageSignals(db, candidateId)).toEqual([]);
  });
});
