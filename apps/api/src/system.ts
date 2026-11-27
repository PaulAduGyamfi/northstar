import type { FeedItem, FeedNames, SetKillSwitchResult } from "@northstar/db";
import type { SystemHealth } from "@northstar/domain";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";
import { errorClassOf } from "./prefill.js";

// The System Health page, the activity feed and the kill switches (NS-153: RES-013, OBS-002,
// RES-008). Every endpoint needs Paul's session: ADR-0002 allows only his authenticated path to
// flip a switch. The database side is packages/db's read paths and setKillSwitch; bin.ts wires
// them, tests fake them.

export type SystemPorts = {
  health: () => Promise<SystemHealth>;
  // Newest first, before a position (or from the newest).
  feedBefore: (before: bigint | undefined, limit: number) => Promise<FeedItem[]>;
  // Oldest first, after a position: what a live feed adds.
  feedAfter: (after: bigint, limit: number) => Promise<FeedItem[]>;
  // The job title and company behind the page's job and application aggregates (NS-189).
  feedNames: (aggregates: string[]) => Promise<Map<string, FeedNames>>;
  setSwitch: (input: {
    subsystem: string;
    enabled: boolean;
    reason: string;
    actor: "user";
  }) => Promise<SetKillSwitchResult>;
};

// The feed page the app asks for: enough for a screen, small enough to poll every few seconds.
const MAX_PAGE = 50;
// The largest log position Postgres can hold (bigint).
const MAX_POSITION = 9223372036854775807n;
// A log position as the query string carries it (a bigint, never a negative or a fraction).
// Past the column's range it is refused here, not by the database.
export const Position = z
  .string()
  .regex(/^\d{1,19}$/)
  .transform((s) => BigInt(s))
  .refine((n) => n <= MAX_POSITION);

const Health = z.object({
  overall: z.enum(["healthy", "degraded", "down"]),
  subsystems: z.array(
    z.object({
      subsystem: z.string(),
      kind: z.enum(["dependency", "switch", "board", "worker"]),
      health: z.enum(["healthy", "degraded", "down"]),
      reason: z.string(),
      retryAt: z.string().nullable(),
    }),
  ),
});

const FeedQuery = z
  .object({
    before: Position.optional(),
    after: Position.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(20),
  })
  .refine((q) => q.before === undefined || q.after === undefined, {
    message: "before and after can't be used together",
  });

const Feed = z.object({
  items: z.array(
    z.object({
      position: z.string(),
      occurredAt: z.string(),
      type: z.string(),
      actor: z.string(),
      line: z.string(),
      // Shown next to the line, never inside it (NS-189). Null when the event names no job.
      jobTitle: z.string().nullable(),
      company: z.string().nullable(),
    }),
  ),
});

// A page's names, or none when they can't be read: the lines still show (fail small, ADR-0007).
async function namesOf(ports: SystemPorts, items: FeedItem[]): Promise<Map<string, FeedNames>> {
  if (items.length === 0) return new Map();
  try {
    return await ports.feedNames([...new Set(items.map((i) => i.aggregate))]);
  } catch {
    return new Map();
  }
}

// An error's class and short code (a SQLSTATE such as "28P01", or a socket code such as
// "ECONNREFUSED"), never its message: drizzle's DrizzleQueryError carries the SQL and its params
// there. drizzle wraps the driver's error and keeps it on `cause`, so the code is looked for one
// level down too, under the same checks; nothing else of either error is read.
export function errorFacts(error: unknown): { error: string; code?: string; cause?: string } {
  const facts: { error: string; code?: string; cause?: string } = { error: errorClassOf(error) };
  const code = codeOf(error);
  const cause = error instanceof Error ? error.cause : undefined;
  if (code) facts.code = code;
  else if (cause instanceof Error) {
    facts.cause = errorClassOf(cause);
    const causeCode = codeOf(cause);
    if (causeCode) facts.code = causeCode;
  }
  return facts;
}

// A short plain code, or nothing; a getter that throws counts as none.
function codeOf(error: unknown): string | undefined {
  try {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

const Flip = z.object({
  subsystem: z.string().min(1).max(100),
  enabled: z.boolean(),
  reason: z.string().max(200),
});

const ERRORS: Record<"InvalidSubsystem" | "ReasonRequired", string> = {
  InvalidSubsystem: "invalid_subsystem",
  ReasonRequired: "reason_required",
};

export function systemEndpoints(ports: SystemPorts): AnyEndpoint[] {
  const health = endpoint({
    method: "GET",
    path: "/system/health",
    auth: "session",
    input: z.object({}),
    output: Health,
    handler: async () => {
      let h: SystemHealth;
      try {
        h = await ports.health();
      } catch (error) {
        // The state can't be read (Postgres down): the page shows everything as down. Say why on
        // the API's own output, as the error's class and Postgres code only (28P01 a wrong
        // password, 42P01 a missing table): a message can quote a connection string.
        console.error(
          JSON.stringify({ level: "error", msg: "health read failed", ...errorFacts(error) }),
        );
        return { ok: false, status: 503, error: "unavailable" };
      }
      const subsystems = h.subsystems.map((s) => ({
        ...s,
        retryAt: s.retryAt?.toISOString() ?? null,
      }));
      return { ok: true, body: { overall: h.overall, subsystems } };
    },
  });

  const feed = endpoint({
    method: "GET",
    path: "/feed",
    auth: "session",
    input: FeedQuery,
    output: Feed,
    handler: async ({ before, after, limit }) => {
      const items =
        after === undefined
          ? await ports.feedBefore(before, limit)
          : await ports.feedAfter(after, limit);
      const names = await namesOf(ports, items);
      return {
        ok: true,
        body: {
          // Fields picked by name: the aggregate id is looked up, never returned.
          items: items.map((i) => ({
            position: i.position.toString(),
            occurredAt: i.occurredAt.toISOString(),
            type: i.type,
            actor: i.actor,
            line: i.line,
            jobTitle: names.get(i.aggregate)?.jobTitle ?? null,
            company: names.get(i.aggregate)?.company ?? null,
          })),
        },
      };
    },
  });

  const flip = endpoint({
    method: "POST",
    path: "/system/kill-switches",
    auth: "session",
    input: Flip,
    output: z.object({ changed: z.boolean() }),
    handler: async ({ subsystem, enabled, reason }) => {
      // Only Paul's signed-in path reaches this, so the flip is his (ADR-0002), whatever the
      // request body says: the fields are picked by name, never spread.
      const r = await ports.setSwitch({ subsystem, enabled, reason, actor: "user" });
      if (!r.ok) return { ok: false, status: 400, error: ERRORS[r.error.kind] };
      return { ok: true, body: { changed: r.changed } };
    },
  });

  return [health, feed, flip];
}
