import { type LlmBudget, pausedPriorities, type Spent } from "@northstar/llm";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// Model spend on System Health (NS-219, RES-009, ADR-0021): today's and this month's spend against
// the caps, and the route priorities the gateway is holding back now, by the gateway's own rule
// (pausedPriorities), behind Paul's session. bin.ts wires the caps and stored spend the gateway
// uses; tests fake them.

export type SpendPorts = {
  caps: LlmBudget;
  spent: () => Promise<Spent>;
};

const Paused = z.object({
  priority: z.enum(["low", "normal", "fresh"]),
  cap: z.enum(["daily", "monthly"]),
});

export function spendEndpoints(ports: SpendPorts): AnyEndpoint[] {
  const spend = endpoint({
    method: "GET",
    path: "/system/spend",
    auth: "session",
    input: z.object({}),
    output: z.object({
      todayUsd: z.number(),
      monthUsd: z.number(),
      dailyCapUsd: z.number().nullable(),
      monthlyCapUsd: z.number().nullable(),
      paused: z.array(Paused),
    }),
    handler: async () => {
      let spent: Spent;
      try {
        spent = await ports.spent();
      } catch {
        // Postgres down: the page says spend can't be read, never that nothing is paused.
        return { ok: false, status: 503, error: "unavailable" };
      }
      const caps = ports.caps;
      return {
        ok: true,
        body: {
          todayUsd: spent.todayUsd,
          monthUsd: spent.monthUsd,
          dailyCapUsd: caps.dailyUsd,
          monthlyCapUsd: caps.monthlyUsd,
          paused: pausedPriorities(spent, caps),
        },
      };
    },
  });
  return [spend];
}
