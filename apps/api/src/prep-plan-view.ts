import type { PrepPlanView } from "@northstar/db";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// A prep plan as the Queue shows it before Paul approves it (NS-241 slice 6, CAL-003): the
// interview it was filed for, each block's kind and times, and whether the interview moved since.
// Behind his session, read-only. The answer is built field by field from readPrepPlanView, so
// nothing else from the stored rows (event id, calendar id, hash) reaches the page. bin.ts wires
// packages/db, tests fake it.

export type PrepPlanPorts = {
  // Null for a request that isn't the server's candidate's `prep_plan`.
  read: (requestId: string) => Promise<PrepPlanView | null>;
};

const Interval = z.object({ start: z.string(), end: z.string() });

const PrepPlan = z.object({
  interview: Interval,
  blocks: z.array(Interval.extend({ kind: z.enum(["prep", "warm_up"]) })),
  rescheduled: z.boolean(),
});

export function prepPlanEndpoints(ports: PrepPlanPorts): AnyEndpoint[] {
  const view = endpoint({
    method: "GET",
    path: "/approvals/prep-plan",
    auth: "session",
    input: z.object({ requestId: z.uuid() }),
    output: PrepPlan,
    handler: async ({ requestId }) => {
      let plan: PrepPlanView | null;
      try {
        plan = await ports.read(requestId);
      } catch {
        // The store couldn't be read: say so, never "no such plan".
        return { ok: false, status: 503, error: "unavailable" };
      }
      if (plan === null) return { ok: false, status: 404, error: "not_found" };
      return {
        ok: true,
        body: {
          interview: {
            start: plan.interview.start.toISOString(),
            end: plan.interview.end.toISOString(),
          },
          blocks: plan.blocks.map((b) => ({
            kind: b.kind,
            start: b.start.toISOString(),
            end: b.end.toISOString(),
          })),
          rescheduled: plan.rescheduled,
        },
      };
    },
  });
  return [view];
}
