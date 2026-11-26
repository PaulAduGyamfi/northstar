import type { ApplicationFilter, ApplicationRow, TimelineItem } from "@northstar/db";
import { APPLICATION_STATUSES, FUNNEL_STAGES, type PipelineMetrics } from "@northstar/domain";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// The pipeline board and application timeline (NS-168, DSH-001, DSH-006): read-only views over
// Paul's applications. Both need his session. Timeline lines come from feedLine in packages/db,
// never raw payloads. bin.ts wires packages/db's reads, tests fake them.

export type PipelinePorts = {
  list: (filter: ApplicationFilter) => Promise<ApplicationRow[]>;
  timeline: (
    applicationId: string,
  ) => Promise<{ application: ApplicationRow; items: TimelineItem[] } | null>;
  // The funnel and breakdowns (NS-208), computed from the status histories.
  metrics: () => Promise<PipelineMetrics>;
};

const Rate = z.object({
  k: z.number(),
  n: z.number(),
  enough: z.boolean(),
  rate: z.number().nullable(),
  low: z.number().nullable(),
  high: z.number().nullable(),
});
const Group = z.object({ key: z.string(), rate: Rate });
const Median = z.object({ days: z.number().nullable(), n: z.number() });
// Counts, rates and keys only: nothing names a job or company.
const Metrics = z.object({
  funnel: z.array(
    z.object({ stage: z.enum(FUNNEL_STAGES), count: z.number(), fromPrevious: Rate.nullable() }),
  ),
  timeInStage: z.object({ toApply: Median, toResponse: Median }),
  responseBy: z.object({
    source: z.array(Group),
    band: z.array(Group),
    timeToApply: z.array(Group),
  }),
});

const Application = z.object({
  applicationId: z.string(),
  status: z.enum(APPLICATION_STATUSES),
  jobTitle: z.string().nullable(),
  company: z.string().nullable(),
  ats: z.string().nullable(),
  fitScore: z.number().nullable(),
  fitBand: z.enum(["queue", "suggest", "skip"]).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// A calendar day as YYYY-MM-DD that is a real date.
const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => {
    // An impossible date parses to NaN (2026-13-01) or rolls over (2026-02-30 → March).
    const ms = Date.parse(`${d}T00:00:00Z`);
    return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(d);
  });

// The pipeline's filters (NS-207, DSH-001): every field optional and checked here, then applied
// in packages/db's SQL as parameters.
const Filter = z
  .object({
    company: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((c) => !/\p{Cc}/u.test(c))
      .optional(),
    band: z.enum(["queue", "suggest", "skip"]).optional(),
    // An ATS name, or "other" for a job with none.
    source: z
      .string()
      .regex(/^[a-z]{2,30}$/)
      .optional(),
    from: Day.optional(),
    to: Day.optional(),
  })
  .refine((f) => f.from === undefined || f.to === undefined || f.from <= f.to, {
    message: "from must not be after to",
  });

const Item = z.object({
  occurredAt: z.string(),
  type: z.string(),
  actor: z.string(),
  line: z.string(),
});

// Built field by field, so nothing the read adds later leaks out.
const toApplication = (a: ApplicationRow) => ({
  applicationId: a.applicationId,
  status: a.status,
  jobTitle: a.jobTitle,
  company: a.company,
  ats: a.ats,
  fitScore: a.fitScore,
  fitBand: a.fitBand,
  createdAt: a.createdAt.toISOString(),
  updatedAt: a.updatedAt.toISOString(),
});

export function pipelineEndpoints(ports: PipelinePorts): AnyEndpoint[] {
  const list = endpoint({
    method: "GET",
    path: "/applications",
    auth: "session",
    input: Filter,
    output: z.object({ items: z.array(Application) }),
    handler: async (filter) => {
      let rows: ApplicationRow[];
      try {
        // Fields picked by name: nothing else in the query reaches the read.
        rows = await ports.list({
          ...(filter.company === undefined ? {} : { company: filter.company }),
          ...(filter.band === undefined ? {} : { band: filter.band }),
          ...(filter.source === undefined ? {} : { source: filter.source }),
          ...(filter.from === undefined ? {} : { from: filter.from }),
          ...(filter.to === undefined ? {} : { to: filter.to }),
        });
      } catch {
        // The pipeline can't be read (Postgres down): the page says so.
        return { ok: false, status: 503, error: "unavailable" };
      }
      return { ok: true, body: { items: rows.map(toApplication) } };
    },
  });

  const timeline = endpoint({
    method: "GET",
    path: "/applications/timeline",
    auth: "session",
    input: z.object({ id: z.uuid() }),
    output: z.object({ application: Application, items: z.array(Item) }),
    handler: async ({ id }) => {
      let found: Awaited<ReturnType<PipelinePorts["timeline"]>>;
      try {
        found = await ports.timeline(id);
      } catch {
        return { ok: false, status: 503, error: "unavailable" };
      }
      if (found === null) return { ok: false, status: 404, error: "not_found" };
      return {
        ok: true,
        body: {
          application: toApplication(found.application),
          items: found.items.map((i) => ({
            occurredAt: i.occurredAt.toISOString(),
            type: i.type,
            actor: i.actor,
            line: i.line,
          })),
        },
      };
    },
  });

  const metrics = endpoint({
    method: "GET",
    path: "/pipeline/metrics",
    auth: "session",
    input: z.object({}),
    output: Metrics,
    handler: async () => {
      try {
        return { ok: true, body: await ports.metrics() };
      } catch {
        return { ok: false, status: 503, error: "unavailable" };
      }
    },
  });

  return [list, timeline, metrics];
}
