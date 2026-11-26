import type { HandoffPackage, HandoffPackageError } from "@northstar/db";
import type { Result } from "@northstar/domain";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// The handoff pre-fill's read (NS-192, APPLY-006): the extension asks for the approved package
// behind one open "Needs your hands" handoff, to fill that form in Paul's own tab (slice 2). It
// takes only the extension's own token (ADR-0019), never a session cookie. Every check (the
// handoff open and his, the approval live, the hash) is the server's, in readHandoffPackage, at
// the moment of the read. The values go in the response only: never into a span, log or error.

export type HandoffPackagePorts = {
  read: (handoffId: string) => Promise<Result<HandoffPackage, HandoffPackageError>>;
};

// Only an https link is ever handed to the extension (the database refuses anything else too).
const HttpsUrl = z.string().regex(/^https:\/\/[^\s]+$/);

const Answer = z.object({
  handoffId: z.string(),
  applicationId: z.string(),
  ats: z.string(),
  applyUrl: HttpsUrl,
  contact: z.object({
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    phone: z.string().nullable(),
  }),
  fields: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
});

// Each refusal as a status and a fixed code: the Gate's reason is never passed through.
const REFUSALS: Record<HandoffPackageError["kind"], { status: 404 | 409; error: string }> = {
  NotFound: { status: 404, error: "not_found" },
  Closed: { status: 409, error: "closed" },
  NoPackage: { status: 409, error: "no_package" },
  NotApproved: { status: 409, error: "not_approved" },
  Changed: { status: 409, error: "changed" },
};

export function handoffPackageEndpoint(ports: HandoffPackagePorts): AnyEndpoint {
  return endpoint({
    method: "POST",
    path: "/handoffs/package",
    auth: "extension",
    input: z.object({ handoffId: z.uuid() }),
    output: Answer,
    handler: async ({ handoffId }, { span }) => {
      const read = await ports.read(handoffId);
      if (!read.ok) {
        // The refusal's kind only, never a value.
        span.setAttribute("handoff_package.refused", read.error.kind);
        return { ok: false, ...REFUSALS[read.error.kind] };
      }
      return { ok: true, body: read.value };
    },
  });
}
