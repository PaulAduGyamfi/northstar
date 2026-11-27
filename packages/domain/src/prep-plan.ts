import { createHash } from "node:crypto";

// A prep plan as Paul approves it (NS-241 slice 4, ADR-0031 item 3): one `prep_plan` Gate request
// per stored proposal, pinning every block the Calendar writer may insert. Plain code, no I/O.

// The fixed event titles (ADR-0031: no company or interviewer name reaches Google). The writer's
// requests send exactly these, and the hash covers them, so a changed title is changed content.
export const PREP_BLOCK_TITLES = { prep: "Interview prep", warm_up: "Interview warm-up" } as const;
export type PrepBlockTitleKind = keyof typeof PREP_BLOCK_TITLES;

// The calendar every block goes to (CAL-001), by its fixed name.
export const PREP_CALENDAR_NAME = "Northstar";

export type PrepPlanContent = {
  proposalId: string;
  // The detection the plan is for, as a row id and version: a reschedule is a new version, so it
  // changes the hash and the writer withdraws the approval (ADR-0031 item 4).
  detectionId: string;
  detectionVersion: number;
  blocks: { kind: PrepBlockTitleKind; start: Date; end: Date }[];
};

// One plan per proposal: the Gate's subject names it.
export function prepPlanSubject(proposalId: string): string {
  return `prep_plan:${proposalId}`;
}

// SHA-256 (hex) of exactly what the writer would send for this plan. Blocks are taken in start
// order, so the order the caller read them in can't change the hash.
export function prepPlanContentSha256(plan: PrepPlanContent): string {
  const blocks = [...plan.blocks]
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .map((b) => [b.kind, b.start.toISOString(), b.end.toISOString(), PREP_BLOCK_TITLES[b.kind]]);
  return createHash("sha256")
    .update(
      JSON.stringify([
        "prep_plan:v1",
        plan.proposalId,
        plan.detectionId,
        plan.detectionVersion,
        PREP_CALENDAR_NAME,
        blocks,
      ]),
    )
    .digest("hex");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The client-chosen id of one block's event (ADR-0031 item 5): the decision's 32 hex digits and
// the block's index. Hex digits and decimal digits are all lowercase base32hex, which
// events.insert accepts, so a retry under the same decision answers 409 instead of making a second
// event, and a new decision (a new plan) never collides with an old one.
export function prepEventId(decisionId: string, index: number): string {
  if (!UUID.test(decisionId)) throw new TypeError("decisionId");
  if (!Number.isInteger(index) || index < 0 || index > 99) throw new TypeError("index");
  return `${decisionId.replaceAll("-", "")}${index}`;
}
