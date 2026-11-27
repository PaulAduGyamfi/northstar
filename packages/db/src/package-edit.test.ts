import { CandidateId } from "@northstar/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applicationPackage } from "./application-package-schema.js";
import { approvalEdit, approvalRequest, approvalWithdrawal } from "./approval-schema.js";
import { decideApprovals, listPendingApprovals, setApprovalPolicies } from "./approval-write.js";
import type { Db } from "./db.js";
import { editPackage } from "./package-edit.js";
import { candidate } from "./schema.js";
import { createTestDb } from "./test/pglite.js";
import { type PackageFixture, packageFixture } from "./test/package-fixture.js";

// Paul's edit of a waiting application package (NS-203 slice 4) on PGlite. Synthetic data only.

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let fixture: PackageFixture;

const FIRST = { question_1: "I like building search tools." };

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  candidateId = CandidateId.parse(c.id);
  fixture = await packageFixture(db, candidateId);
});
afterEach(() => close());

// A package filed with one filled field, waiting for Paul.
async function filed(fields: Record<string, string> = FIRST): Promise<string> {
  const result = await fixture.file({ fields });
  if (!result.ok) throw new Error(result.error.kind);
  return result.value.requestId;
}

const edit = (requestId: string, fields: Record<string, string>, who = candidateId) =>
  editPackage(db, { candidateId: who, requestId, fields });

async function requestRow(id: string) {
  const [row] = await db.select().from(approvalRequest).where(eq(approvalRequest.id, id));
  return row;
}

describe("editPackage", () => {
  it("withdraws the old request as Paul's and files the edited package under the same subject", async () => {
    const old = await filed();
    const result = await edit(old, { question_1: "I like building tools for search." });
    if (!result.ok) throw new Error(result.error.kind);
    const [withdrawal] = await db
      .select({ by: approvalWithdrawal.withdrawnBy })
      .from(approvalWithdrawal)
      .where(eq(approvalWithdrawal.requestId, old));
    const [link] = await db
      .select({ previous: approvalEdit.previousRequestId })
      .from(approvalEdit)
      .where(eq(approvalEdit.requestId, result.value.requestId));
    const before = await requestRow(old);
    const after = await requestRow(result.value.requestId);
    expect({
      withdrawnBy: withdrawal?.by,
      linkedFrom: link?.previous,
      sameSubject: before?.subject === after?.subject,
      pending: (await listPendingApprovals(db, candidateId)).map((p) => p.requestId),
    }).toEqual({
      withdrawnBy: "user",
      linkedFrom: old,
      sameSubject: true,
      pending: [result.value.requestId],
    });
  });

  it("stores the edited package behind the new request, with only the edited field changed", async () => {
    const old = await filed();
    const result = await edit(old, { question_1: "I like building tools for search." });
    if (!result.ok) throw new Error(result.error.kind);
    const rows = await db
      .select({ requestId: applicationPackage.requestId, pkg: applicationPackage.package })
      .from(applicationPackage)
      .where(eq(applicationPackage.candidateId, candidateId));
    const before = rows.find((r) => r.requestId === old)?.pkg;
    const after = rows.find((r) => r.requestId === result.value.requestId)?.pkg;
    expect(after).toEqual({
      ...before,
      fields: { question_1: "I like building tools for search." },
    });
  });

  it("derives the edited package's facts again, every field counting as new", async () => {
    const old = await filed();
    const result = await edit(old, { question_1: "Search tools are what I build best." });
    if (!result.ok) throw new Error(result.error.kind);
    expect((await requestRow(result.value.requestId))?.facts).toEqual({
      fit: 92,
      adapter: "known",
      formSeenBefore: true,
      answers: [{ source: "new", freeTextWords: 7 }],
    });
  });

  it("never lets a policy approve the edit, even one that approved the package as filed", async () => {
    await setApprovalPolicies(db, {
      candidateId,
      rules: [
        {
          name: "strong",
          kind: "application_package",
          minFit: 70,
          allowHighConfidenceAnswers: false,
          maxFreeTextWords: 50,
        },
      ],
    });
    // No fields: every answer is reused, so the rule approves it as filed.
    const approved = await fixture.file({});
    // One field Paul wrote himself: the rule leaves it to him.
    const waiting = await filed();
    const result = await edit(waiting, { question_1: "Search tools are what I build best." });
    if (!result.ok) throw new Error(result.error.kind);
    expect({
      filedApproved: approved.ok ? approved.value.outcome : approved.error.kind,
      pending: (await listPendingApprovals(db, candidateId)).map((p) => p.requestId),
    }).toEqual({
      filedApproved: { auto: true, rule: "strong" },
      pending: [result.value.requestId],
    });
  });

  it("returns the same new request when the same edit is repeated", async () => {
    const old = await filed();
    const fields = { question_1: "Search tools are what I build best." };
    const first = await edit(old, fields);
    const again = await edit(old, fields);
    if (!first.ok) throw new Error(first.error.kind);
    expect(again).toEqual({
      ok: true,
      value: { requestId: first.value.requestId, previousRequestId: old, replayed: true },
    });
  });

  it("refuses a field the package doesn't fill, a blank answer and an unchanged one", async () => {
    const old = await filed();
    expect([
      await edit(old, { question_9: "Something new." }),
      await edit(old, { question_1: "   " }),
      await edit(old, {}),
      await edit(old, FIRST),
    ]).toEqual([
      { ok: false, error: { kind: "InvalidRequest", fields: ["fields.question_9"] } },
      { ok: false, error: { kind: "InvalidRequest", fields: ["fields.question_1"] } },
      { ok: false, error: { kind: "InvalidRequest", fields: ["fields"] } },
      { ok: false, error: { kind: "ContentUnchanged" } },
    ]);
    expect((await listPendingApprovals(db, candidateId)).map((p) => p.requestId)).toEqual([old]);
  });

  it("refuses a package Paul already decided", async () => {
    const old = await filed();
    const decided = await decideApprovals(db, {
      candidateId,
      requestIds: [old],
      decision: "approve",
    });
    if (!decided.ok) throw new Error("not decided");
    expect(await edit(old, { question_1: "Search tools are what I build best." })).toEqual({
      ok: false,
      error: { kind: "NotPending" },
    });
  });

  it("doesn't find another candidate's package, a request with no package or a bad id", async () => {
    const old = await filed();
    const [other] = await db.insert(candidate).values({ displayName: "Other" }).returning();
    if (!other) throw new Error("no candidate");
    const fields = { question_1: "Search tools are what I build best." };
    expect([
      await edit(old, fields, CandidateId.parse(other.id)),
      await edit("00000000-0000-4000-8000-000000000001", fields),
      await edit("not-a-uuid", fields),
    ]).toEqual([
      { ok: false, error: { kind: "NotFound" } },
      { ok: false, error: { kind: "NotFound" } },
      { ok: false, error: { kind: "NotFound" } },
    ]);
    const stored = await db
      .select({ id: applicationPackage.id })
      .from(applicationPackage)
      .where(eq(applicationPackage.candidateId, candidateId));
    expect(stored).toHaveLength(1);
  });
});
