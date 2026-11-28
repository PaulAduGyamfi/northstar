import { z } from "zod";
import { SESSION_COOKIE } from "./session";

// The System Health page, the health dot and the live feed (NS-153): the API's answers and the
// plain decisions made from them. The web app holds no secret: it forwards Paul's session cookie
// to the API and shows what comes back.

const Health = z.enum(["healthy", "degraded", "down"]);

export const HealthBody = z.object({
  overall: Health,
  subsystems: z.array(
    z.object({
      subsystem: z.string(),
      kind: z.enum(["dependency", "switch", "board", "worker"]),
      health: Health,
      reason: z.string(),
      retryAt: z.string().nullable(),
    }),
  ),
});
export type HealthView = z.infer<typeof HealthBody>;

const Line = z.object({
  position: z.string(),
  occurredAt: z.string(),
  type: z.string(),
  actor: z.string(),
  line: z.string(),
  // The job the line is about (NS-189), from the API's join; null when it names none.
  jobTitle: z.string().nullable(),
  company: z.string().nullable(),
});
export type FeedLine = z.infer<typeof Line>;
export const FeedBody = z.object({ items: z.array(Line) });

// The label shown after a feed line: "Title at Company", whichever one is known, or nothing.
// Rendered as text, never as HTML: the names come from job postings.
export function feedSubject(l: Pick<FeedLine, "jobTitle" | "company">): string | null {
  if (l.jobTitle && l.company) return `${l.jobTitle} at ${l.company}`;
  return l.jobTitle || l.company || null;
}

export type ApiResult<T> =
  | { kind: "ok"; body: T }
  | { kind: "signed_out" }
  // The API answered, but not with the page: 503 means it couldn't read the state.
  | { kind: "error"; status: number }
  // The API is down or answered something off-schema.
  | { kind: "unreachable" };

// The API's token shape (src/session.ts): anything else is never forwarded.
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TIMEOUT_MS = 3_000;

// A GET to the API with Paul's session cookie, checked against the page's schema.
export async function readApi<T>(
  deps: { apiOrigin: string; token: string | undefined; fetch: typeof fetch },
  path: string,
  schema: z.ZodType<T>,
): Promise<ApiResult<T>> {
  if (deps.token === undefined || !TOKEN.test(deps.token)) return { kind: "signed_out" };
  try {
    const res = await deps.fetch(`${deps.apiOrigin}${path}`, {
      headers: { cookie: `${SESSION_COOKIE}=${deps.token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) return { kind: "signed_out" };
    if (res.status !== 200) return { kind: "error", status: res.status };
    const body = schema.safeParse(await res.json());
    return body.success ? { kind: "ok", body: body.data } : { kind: "unreachable" };
  } catch {
    return { kind: "unreachable" };
  }
}

// The switches always offered (RES-008), before any source or other switch. `push` since NS-193:
// it stops every web push (ADR-0032).
const FIXED = ["auto_apply", "outreach_send", "inbox_auto_label", "push"];

export type SwitchItem = { subsystem: string; on: boolean };

// Which kill switches the page shows, and whether each is on: the fixed ones, a source switch per
// ATS with a watched board, and any other subsystem that has ever been switched. No stored row
// means on; a switched-off subsystem shows as down in the health model.
export function switchList(health: HealthView): SwitchItem[] {
  const switched = new Map(
    health.subsystems.filter((s) => s.kind === "switch").map((s) => [s.subsystem, s]),
  );
  const sources = new Set<string>();
  for (const s of health.subsystems) {
    if (s.kind !== "board") continue;
    const ats = s.subsystem.split(":")[1];
    if (ats) sources.add(`source:${ats}`);
  }
  const names = [
    ...FIXED,
    ...[...sources].sort(),
    ...[...switched.keys()].filter((n) => !FIXED.includes(n) && !sources.has(n)).sort(),
  ];
  return names.map((subsystem) => ({
    subsystem,
    on: switched.get(subsystem)?.health !== "down",
  }));
}

export type DotStatus = "healthy" | "degraded" | "down";

// The nav's health dot: the overall status, or down when the state can't be read at all.
export function dotStatus(r: ApiResult<HealthView>): DotStatus | null {
  if (r.kind === "ok") return r.body.overall;
  if (r.kind === "signed_out") return null;
  return "down";
}

// New feed lines (oldest first, from GET /feed?after=) on top of what is shown (newest first),
// each line once, at most `max`.
export function mergeFeed(shown: FeedLine[], incoming: FeedLine[], max: number): FeedLine[] {
  const seen = new Set(shown.map((l) => l.position));
  const fresh = incoming.filter((l) => !seen.has(l.position)).reverse();
  return [...fresh, ...shown].slice(0, max);
}
