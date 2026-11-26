import { z } from "zod";

// The LLM spend cap (NS-176 slice 2, RES-009, ADR-0021): daily and monthly caps in US dollars, and
// the share of a cap each route priority may reach before it is held back. Low-priority work
// pauses first; fresh-job routes keep running past the cap up to a hard ceiling (SRC-013).

export type RoutePriority = "fresh" | "normal" | "low";

// `null` means no cap.
export type LlmBudget = { dailyUsd: number | null; monthlyUsd: number | null };

export const NO_BUDGET: LlmBudget = { dailyUsd: null, monthlyUsd: null };

// What has been spent so far, in US dollars, by UTC day and month.
export type Spent = { todayUsd: number; monthUsd: number };

// Where spend is read and recorded (packages/db's llm_spend, wired by each entry point).
export type SpendMeter = {
  spent: () => Promise<Spent>;
  record: (route: string, costUsd: number) => Promise<void>;
};

// The share of a cap at which each priority is held back (ADR-0021).
export const HOLD_AT: Readonly<Record<RoutePriority, number>> = {
  low: 0.8,
  normal: 1,
  fresh: 1.25,
};

// Which cap holds this priority back now, or null when it may run.
export function budgetHold(
  spent: Spent,
  caps: LlmBudget,
  priority: RoutePriority,
): "daily" | "monthly" | null {
  const share = HOLD_AT[priority];
  if (caps.dailyUsd !== null && spent.todayUsd >= caps.dailyUsd * share) return "daily";
  if (caps.monthlyUsd !== null && spent.monthUsd >= caps.monthlyUsd * share) return "monthly";
  return null;
}

// An optional positive amount of dollars, from text.
const Cap = z
  .string()
  .regex(/^\d{1,6}(\.\d{1,2})?$/)
  .transform(Number)
  .refine((n) => n > 0)
  .optional();

const Settings = z.object({ LLM_DAILY_CAP_USD: Cap, LLM_MONTHLY_CAP_USD: Cap });

// The one place the caps are read. Entry points pass their settings in; app code never reads the
// process environment (AGENTS.md). A bad value names the setting, never its value.
export function loadLlmBudget(settings: Record<string, string | undefined>): LlmBudget {
  const parsed = Settings.safeParse({
    LLM_DAILY_CAP_USD: settings.LLM_DAILY_CAP_USD || undefined,
    LLM_MONTHLY_CAP_USD: settings.LLM_MONTHLY_CAP_USD || undefined,
  });
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ");
    throw new Error(`${names}: a positive amount of US dollars, like 5 or 12.50`);
  }
  return {
    dailyUsd: parsed.data.LLM_DAILY_CAP_USD ?? null,
    monthlyUsd: parsed.data.LLM_MONTHLY_CAP_USD ?? null,
  };
}
