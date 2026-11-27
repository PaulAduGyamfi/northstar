import { describe, expect, it } from "vitest";
import {
  type PrepPlanContent,
  prepEventId,
  prepPlanContentSha256,
  prepPlanSubject,
} from "./prep-plan.js";

// A prep plan's subject, hash and event ids (NS-241 slice 4, ADR-0031).

const PREP = {
  kind: "prep" as const,
  start: new Date("2026-12-01T15:00:00Z"),
  end: new Date("2026-12-01T15:45:00Z"),
};
const WARM = {
  kind: "warm_up" as const,
  start: new Date("2026-12-03T14:00:00Z"),
  end: new Date("2026-12-03T14:15:00Z"),
};
const PLAN: PrepPlanContent = {
  proposalId: "11111111-1111-4111-8111-111111111111",
  detectionId: "22222222-2222-4222-8222-222222222222",
  detectionVersion: 1,
  blocks: [PREP, WARM],
};

describe("prep plan", () => {
  it("names the proposal in the subject", () => {
    expect(prepPlanSubject(PLAN.proposalId)).toBe(`prep_plan:${PLAN.proposalId}`);
  });

  it("hashes the same plan the same way whatever order its blocks come in", () => {
    const reversed = { ...PLAN, blocks: [...PLAN.blocks].reverse() };
    expect(prepPlanContentSha256(reversed)).toBe(prepPlanContentSha256(PLAN));
    expect(prepPlanContentSha256(PLAN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the hash when a block, the detection version or the proposal changes", () => {
    const base = prepPlanContentSha256(PLAN);
    const moved = { ...PLAN, blocks: [{ ...PREP, end: new Date("2026-12-01T16:00:00Z") }, WARM] };
    const kind = { ...PLAN, blocks: [{ ...PREP, kind: "warm_up" as const }, WARM] };
    expect(prepPlanContentSha256(moved)).not.toBe(base);
    expect(prepPlanContentSha256(kind)).not.toBe(base);
    expect(prepPlanContentSha256({ ...PLAN, detectionVersion: 2 })).not.toBe(base);
    expect(prepPlanContentSha256({ ...PLAN, detectionId: PLAN.proposalId })).not.toBe(base);
    expect(prepPlanContentSha256({ ...PLAN, proposalId: PLAN.detectionId })).not.toBe(base);
    expect(prepPlanContentSha256({ ...PLAN, blocks: PLAN.blocks.slice(1) })).not.toBe(base);
  });

  it("derives event ids Google accepts, one per block and decision", () => {
    const decision = "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";
    const first = prepEventId(decision, 0);
    expect(first).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(first).toBe("a0b1c2d3e4f54a6b8c7d9e0f1a2b3c4d0");
    expect(prepEventId(decision, 1)).not.toBe(first);
    expect(prepEventId("b0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d", 0)).not.toBe(first);
  });

  it("refuses an id that isn't a decision uuid or a bad index", () => {
    expect(() => prepEventId("not-a-uuid", 0)).toThrow(TypeError);
    expect(() => prepEventId("A0B1C2D3-E4F5-4A6B-8C7D-9E0F1A2B3C4D", 0)).toThrow(TypeError);
    expect(() => prepEventId("a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d", -1)).toThrow(TypeError);
    expect(() => prepEventId("a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d", 1.5)).toThrow(TypeError);
  });
});
