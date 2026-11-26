import { type Db, listOpenDeadLetters, readEventsAfter } from "@northstar/db";
import { createTestDb, seedApplication } from "@northstar/db/testing";
import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEndingActivities } from "./ending.js";

let db: Db;
let close: () => Promise<void>;
let candidateId: string;
let applicationId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ({ candidateId, applicationId } = await seedApplication(db, "awaiting_approval"));
});
afterEach(() => close());

const lettersFor = () => listOpenDeadLetters(db, CandidateId.parse(candidateId));
const endingEvents = async () =>
  (await readEventsAfter(db, CandidateId.parse(candidateId), 0n, 500)).filter(
    (e) => e.event.type === "dead_letter.recorded",
  );

describe("the recordSubmissionEnding activity", () => {
  it("stores one dead letter and one feed event for the application", async () => {
    const { recordSubmissionEnding } = createEndingActivities(db);
    await expect(
      recordSubmissionEnding({
        candidateId,
        applicationId,
        reasonCode: "refused_duplicate_requisition",
        attempts: 1,
      }),
    ).resolves.toEqual({ status: "recorded" });
    const letters = await lettersFor();
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({
      kind: "apply.submission",
      subject: `application:${applicationId}`,
      reasonCode: "refused_duplicate_requisition",
      attempts: 1,
    });
    expect(await endingEvents()).toHaveLength(1);
  });

  it("stores nothing more when the same ending is recorded again", async () => {
    const { recordSubmissionEnding } = createEndingActivities(db);
    const args = { candidateId, applicationId, reasonCode: "activity_failed", attempts: 5 };
    await recordSubmissionEnding(args);
    await expect(recordSubmissionEnding(args)).resolves.toEqual({ status: "exists" });
    expect(await lettersFor()).toHaveLength(1);
    expect(await endingEvents()).toHaveLength(1);
  });

  it.each([
    [{ candidateId: "nope" }, "candidateId is not a uuid"],
    [{ applicationId: "application:x" }, "applicationId is not a uuid"],
    [{ reasonCode: "Not a code" }, "invalid dead letter: reasonCode"],
    [{ attempts: 0 }, "invalid dead letter: attempts"],
  ] as const)("refuses bad input %o without retry and stores nothing", async (change, message) => {
    const { recordSubmissionEnding } = createEndingActivities(db);
    await expect(
      recordSubmissionEnding({
        candidateId,
        applicationId,
        reasonCode: "gave_up_held_back",
        attempts: 3,
        ...change,
      }),
    ).rejects.toMatchObject({ type: "InvalidInput", nonRetryable: true, message });
    expect(await lettersFor()).toHaveLength(0);
  });
});
