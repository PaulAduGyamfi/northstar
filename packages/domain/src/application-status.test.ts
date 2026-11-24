import { describe, expect, it } from "vitest";
import {
  APPLICATION_STATUSES,
  type ApplicationStatus,
  isTerminal,
  nextStatus,
} from "./application-status.js";

// The allowed moves, written out by hand (spec NS-105, open question 2) so that any change to the
// table in application-status.ts has to change this list too.
const EXPECTED_MOVES: ReadonlyArray<readonly [ApplicationStatus, ApplicationStatus]> = [
  ["discovered", "scored"],
  ["discovered", "withdrawn"],
  ["scored", "queued"],
  ["scored", "withdrawn"],
  ["queued", "package_ready"],
  ["queued", "withdrawn"],
  ["package_ready", "awaiting_approval"],
  ["package_ready", "withdrawn"],
  ["awaiting_approval", "submitting"],
  ["awaiting_approval", "queued"],
  ["awaiting_approval", "withdrawn"],
  ["submitting", "submitted"],
  ["submitting", "needs_human"],
  ["submitting", "withdrawn"],
  ["needs_human", "submitting"],
  ["needs_human", "submitted"],
  ["needs_human", "withdrawn"],
  ["submitted", "confirmed"],
  ["submitted", "in_process"],
  ["submitted", "rejected"],
  ["submitted", "ghosted"],
  ["submitted", "withdrawn"],
  ["confirmed", "in_process"],
  ["confirmed", "rejected"],
  ["confirmed", "ghosted"],
  ["confirmed", "withdrawn"],
  ["in_process", "offer"],
  ["in_process", "rejected"],
  ["in_process", "ghosted"],
  ["in_process", "withdrawn"],
  ["offer", "withdrawn"],
  ["ghosted", "in_process"],
  ["ghosted", "rejected"],
];

const isExpected = (from: ApplicationStatus, to: ApplicationStatus): boolean =>
  EXPECTED_MOVES.some(([f, t]) => f === from && t === to);

describe("application status machine", () => {
  it("lists the 14 statuses from requirement 03 in pipeline order", () => {
    expect(APPLICATION_STATUSES).toEqual([
      "discovered",
      "scored",
      "queued",
      "package_ready",
      "awaiting_approval",
      "submitting",
      "needs_human",
      "submitted",
      "confirmed",
      "in_process",
      "offer",
      "rejected",
      "withdrawn",
      "ghosted",
    ]);
  });

  it("allows exactly the expected moves and refuses every other pair of statuses", () => {
    for (const from of APPLICATION_STATUSES) {
      for (const to of APPLICATION_STATUSES) {
        const result = nextStatus(from, to);
        if (isExpected(from, to)) {
          expect(result).toEqual({ ok: true, value: to });
        } else {
          expect(result).toEqual({ ok: false, error: { kind: "IllegalTransition", from, to } });
        }
      }
    }
  });

  it("treats rejected and withdrawn as the only terminal statuses", () => {
    const terminal = APPLICATION_STATUSES.filter((s) => isTerminal(s));
    expect(terminal).toEqual(["rejected", "withdrawn"]);
  });

  it("gives a terminal status no way out", () => {
    for (const to of APPLICATION_STATUSES) {
      expect(nextStatus("rejected", to).ok).toBe(false);
      expect(nextStatus("withdrawn", to).ok).toBe(false);
    }
  });
});
