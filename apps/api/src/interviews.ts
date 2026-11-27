import type { FeedNames, InterviewDecisionKind, StoredInterview } from "@northstar/db";
import { INTERVIEW_FORMATS } from "@northstar/domain";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// Detected interviews and Paul's confirm step (NS-240 slice 5, CAL-002), behind his session.
// A detection comes from a calendar invite, which isn't authenticated, so it is a proposal: Paul
// confirms or dismisses it once, and neither moves an application's status. The response carries
// ids, the format, times, a count, the decision and the job's own title and company from Paul's
// job row: never the invite's title, an address or a name. bin.ts wires packages/db, tests fake it.

const DECISIONS = ["confirmed", "dismissed"] as const satisfies readonly InterviewDecisionKind[];

export type InterviewPorts = {
  list: () => Promise<StoredInterview[]>;
  // The job's title and company per `application:<id>` aggregate (readFeedNames).
  names: (aggregates: readonly string[]) => Promise<Map<string, FeedNames>>;
  decide: (input: { detectionId: string; decision: InterviewDecisionKind }) => Promise<
    | { ok: true; value: { recorded: boolean } }
    | {
        ok: false;
        error:
          | { kind: "UnknownDetection" }
          | { kind: "Superseded" }
          | { kind: "AlreadyDecided"; decision: InterviewDecisionKind };
      }
  >;
};

const Interview = z.object({
  detectionId: z.string(),
  applicationId: z.string(),
  format: z.enum(INTERVIEW_FORMATS),
  start: z.string(),
  end: z.string(),
  interviewerCount: z.number(),
  decision: z.enum(DECISIONS).nullable(),
  jobTitle: z.string().nullable(),
  company: z.string().nullable(),
});

const Decide = z.object({
  detectionId: z.string().uuid(),
  decision: z.enum(DECISIONS),
});

export function interviewEndpoints(ports: InterviewPorts): AnyEndpoint[] {
  const list = endpoint({
    method: "GET",
    path: "/interviews",
    auth: "session",
    input: z.object({}),
    output: z.object({ items: z.array(Interview) }),
    handler: async () => {
      try {
        const interviews = await ports.list();
        const names = await ports.names(interviews.map((i) => `application:${i.applicationId}`));
        return {
          ok: true,
          body: {
            // Fields picked by name: the calendar event id stays on the server.
            items: interviews.map((i) => {
              const n = names.get(`application:${i.applicationId}`);
              return {
                detectionId: i.detectionId,
                applicationId: i.applicationId,
                format: i.format,
                start: i.start.toISOString(),
                end: i.end.toISOString(),
                interviewerCount: i.interviewerCount,
                decision: i.decision,
                jobTitle: n?.jobTitle ?? null,
                company: n?.company ?? null,
              };
            }),
          },
        };
      } catch {
        // An unreadable list says so; it never reads as "no interviews".
        return { ok: false, status: 503, error: "unavailable" };
      }
    },
  });

  const decide = endpoint({
    method: "POST",
    path: "/interviews/decide",
    auth: "session",
    input: Decide,
    output: z.object({ decision: z.enum(DECISIONS), recorded: z.boolean() }),
    handler: async ({ detectionId, decision }) => {
      try {
        // Only Paul's signed-in path reaches this; decideInterview records it as his.
        const r = await ports.decide({ detectionId, decision });
        if (r.ok) return { ok: true, body: { decision, recorded: r.value.recorded } };
        if (r.error.kind === "UnknownDetection") {
          return { ok: false, status: 404, error: "not_found" };
        }
        // A reschedule replaced it: the page reloads and Paul decides on the current time.
        if (r.error.kind === "Superseded") return { ok: false, status: 409, error: "superseded" };
        return { ok: false, status: 409, error: "already_decided" };
      } catch {
        return { ok: false, status: 503, error: "unavailable" };
      }
    },
  });

  return [list, decide];
}
