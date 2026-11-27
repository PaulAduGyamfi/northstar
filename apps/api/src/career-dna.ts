import type { CareerDnaSnapshot, StoredCareerDna } from "@northstar/db";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// The Career DNA page (NS-130 slice 8, DNA-001/008): the newest stored report and what changed
// since the version before it, behind Paul's session. Read-only. The stored snapshot holds scores
// and cited ids, never Paul's lines; this answer leaves the ids out too, since a page can't use
// them. bin.ts wires the history reader and the report's own diff wording (packages/profile);
// tests fake them.

export type CareerDnaPorts = {
  // Newest first, as readCareerDnaHistory gives them.
  history: () => Promise<StoredCareerDna[]>;
  // What changed from the previous version (null before the first) to this one, in the report's
  // own fixed sentences.
  describe: (
    previous: CareerDnaSnapshot | null,
    next: CareerDnaSnapshot,
  ) => { first: boolean; changes: string[] };
  // The current rubric's name for a dimension key, or null when it no longer has that dimension.
  labelOf: (key: string) => string | null;
};

const Dimension = z.object({
  key: z.string(),
  label: z.string().nullable(),
  band: z.enum(["not_enough", "low", "medium", "high"]),
  points: z.number().int().nullable(),
  evidenceCount: z.number().int(),
});

export function careerDnaEndpoints(ports: CareerDnaPorts): AnyEndpoint[] {
  const read = endpoint({
    method: "GET",
    path: "/career-dna",
    auth: "session",
    input: z.object({}),
    output: z.object({
      report: z
        .object({
          version: z.number().int(),
          createdAt: z.string(),
          label: z.string().nullable(),
          dimensions: z.array(Dimension),
          first: z.boolean(),
          changes: z.array(z.string()),
        })
        .nullable(),
    }),
    handler: async () => {
      let history: StoredCareerDna[];
      try {
        history = await ports.history();
      } catch {
        // Postgres down: the page says the report can't be read, never that there is none.
        return { ok: false, status: 503, error: "unavailable" };
      }
      const [newest, previous] = history;
      if (!newest) return { ok: true, body: { report: null } };
      const { first, changes } = ports.describe(previous ?? null, newest);
      return {
        ok: true,
        body: {
          report: {
            version: newest.version,
            createdAt: newest.createdAt.toISOString(),
            label: newest.archetype?.label ?? null,
            // Field by field: the stored atom and story ids never leave the API.
            dimensions: newest.dimensions.map((d) => ({
              key: d.key,
              label: ports.labelOf(d.key),
              band: d.band,
              points: d.points,
              evidenceCount: d.evidenceCount,
            })),
            first,
            changes,
          },
        },
      };
    },
  });
  return [read];
}
