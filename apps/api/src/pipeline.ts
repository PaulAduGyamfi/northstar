import type { ApplicationRow, TimelineItem } from "@northstar/db";
import { APPLICATION_STATUSES } from "@northstar/domain";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// The pipeline board and application timeline (NS-168, DSH-001, DSH-006): read-only views over
// Paul's applications. Both need his session. Timeline lines come from feedLine in packages/db,
// never raw payloads. bin.ts wires packages/db's reads, tests fake them.

export type PipelinePorts = {
  list: () => Promise<ApplicationRow[]>;
  timeline: (
    applicationId: string,
  ) => Promise<{ application: ApplicationRow; items: TimelineItem[] } | null>;
};

const Application = z.object({
  applicationId: z.string(),
  status: z.enum(APPLICATION_STATUSES),
  jobTitle: z.string().nullable(),
  company: z.string().nullable(),
  ats: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
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
  createdAt: a.createdAt.toISOString(),
  updatedAt: a.updatedAt.toISOString(),
});

export function pipelineEndpoints(ports: PipelinePorts): AnyEndpoint[] {
  const list = endpoint({
    method: "GET",
    path: "/applications",
    auth: "session",
    input: z.object({}),
    output: z.object({ items: z.array(Application) }),
    handler: async () => {
      let rows: ApplicationRow[];
      try {
        rows = await ports.list();
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

  return [list, timeline];
}
