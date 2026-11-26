import type { SubmissionView } from "@northstar/db";
import { CandidateId, err, ok } from "@northstar/domain";
import { describe, expect, it } from "vitest";
import { ApplyInvariantError, type SweepPorts, sweepStaleClaims } from "./stale.js";

// The sweep's failure handling on fakes; its behavior on the real write paths is in
// sweep-db.test.ts.

const CANDIDATE = CandidateId.parse("00000000-0000-4000-8000-000000000001");
const APP_A = "00000000-0000-4000-8000-00000000000a";
const APP_B = "00000000-0000-4000-8000-00000000000b";

const claim = (submissionId: string, applicationId: string): SubmissionView => ({
  submissionId,
  applicationId,
  decisionId: "00000000-0000-4000-8000-0000000000dd",
  ats: "greenhouse",
  status: "in_progress",
  reason: null,
  startedAt: new Date("2026-11-25T12:00:00Z"),
  finishedAt: null,
});

describe("sweepStaleClaims", () => {
  it("closes every other stale claim when one fails, then throws that failure", async () => {
    const recorded: string[] = [];
    const ports: SweepPorts = {
      listStaleClaims: async () => [claim("sub-a", APP_A), claim("sub-b", APP_B)],
      listHalfClosedClaims: async () => [],
      recordNeedsHuman: async (_c, id) => {
        recorded.push(id);
        return ok(claim(id, id === "sub-a" ? APP_A : APP_B));
      },
      // Application A refuses every move; B moves normally.
      transitionApplication: async (input) =>
        input.applicationId === APP_A
          ? err({ kind: "NotFound", applicationId: APP_A })
          : ok({} as never),
    };
    await expect(sweepStaleClaims(ports, CANDIDATE)).rejects.toBeInstanceOf(ApplyInvariantError);
    expect(recorded).toEqual(["sub-a", "sub-b"]);
  });
});
