import { detectAts, type IngestResult } from "@northstar/sources";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// POST /jobs/capture (NS-128, SRC-002): the browser extension's "Save to Northstar". A posting on
// a known ATS (Greenhouse, Lever, Ashby, Workday, …) is read through the ATS's own API, the same
// path as `jobs add <url>`. Any other page is saved from the text Paul is looking at, the same
// path as `jobs add --text`: the server never fetches a host the page's owner controls, because
// safeFetch checks an address and then resolves the name again, and a page owner controls their
// DNS (rebinding to a local address). The text is untrusted data: it only ever reaches the
// job-extract route, whose provenance check applies.

// The longest page text taken. The model reads the first 12,000 characters (PAGE_LIMIT in
// packages/sources); a little more leaves room for the page's header before the posting.
export const MAX_PAGE_TEXT = 20_000;
// Room for the text above in UTF-8 (up to 3 bytes a character here), the URL and the title.
const CAPTURE_MAX_BODY = 96 * 1024;

// The two ingest paths, from packages/sources. bin.ts wires them to the database and the model.
export type CapturePorts = {
  byUrl: (url: string) => Promise<IngestResult>;
  byText: (url: string, text: string) => Promise<IngestResult>;
};

const Capture = z.object({
  url: z.string().min(1).max(2048),
  title: z.string().max(500).optional(),
  // Trimmed first, so a page of whitespace counts as empty whatever the caller sent.
  text: z.string().trim().min(1).max(MAX_PAGE_TEXT),
});

// Field names and ids only: a job's values never travel back to the browser.
const Captured = z.object({
  status: z.enum(["created", "merged", "unchanged", "refused", "not_a_job", "failed"]),
  // Which path produced the answer: the link, or the page text.
  via: z.enum(["link", "text"]),
  jobId: z.string().nullable(),
  found: z.array(z.string()),
  missing: z.array(z.string()),
  reason: z.string().nullable(),
});
type Captured = z.infer<typeof Captured>;

// What reading an ATS link can end in that the page text may still save: refused (a link the
// ATS client won't read), failed (the ATS didn't answer), or not a job.
const TRY_TEXT = new Set<IngestResult["status"]>(["refused", "failed", "not_a_job"]);

export function captureEndpoint(ports: CapturePorts): AnyEndpoint {
  return endpoint({
    method: "POST",
    path: "/jobs/capture",
    auth: "extension",
    maxBodyBytes: CAPTURE_MAX_BODY,
    input: Capture,
    output: Captured,
    handler: async ({ url, title, text }) => {
      if (detectAts(url) !== null) {
        const byLink = await ports.byUrl(url);
        if (!TRY_TEXT.has(byLink.status)) return { ok: true, body: answer(byLink, "link") };
      }
      // The title leads, so the model sees it with the description.
      const page = title ? `${title}\n\n${text}` : text;
      return { ok: true, body: answer(await ports.byText(url, page), "text") };
    },
  });
}

function answer(r: IngestResult, via: Captured["via"]): Captured {
  switch (r.status) {
    case "created":
    case "merged":
    case "unchanged":
      return {
        status: r.status,
        via,
        jobId: r.jobId,
        found: r.found,
        missing: r.missing,
        reason: null,
      };
    case "refused":
    case "failed":
      return { status: r.status, via, jobId: null, found: [], missing: [], reason: r.reason };
    case "not_a_job":
      return { status: r.status, via, jobId: null, found: [], missing: [], reason: null };
  }
}
