import type { DedupeCandidate, JobFields, JobSourceInput, SaveResult } from "@northstar/db";
import type { CallRecord, LlmGateway, Route } from "@northstar/llm";
import { ashby } from "./ats/ashby.js";
import { type AtsTarget, detectAts } from "./ats/detect.js";
import { greenhouse } from "./ats/greenhouse.js";
import { lever } from "./ats/lever.js";
import { workday } from "./ats/workday.js";
import { findDuplicate } from "./dedupe.js";
import { type Extraction, emptyFields, htmlToText } from "./extraction.js";
import { canonicalUrl, type FetchDeps, FetchRefused, safeFetch } from "./fetch.js";
import {
  checkJobProvenance,
  type DroppedField,
  type JobExtractInput,
} from "./job-extract-route.js";
import type { JobExtract } from "./job-extract-schema.js";
import { fromJsonLd } from "./jsonld.js";
import { termsFor } from "./terms.js";

// Adding one job (SRC-001): pick the most reliable way to read the posting, then store it once
// (SRC-006). Plain code wherever the page offers structure; the model only for a page without it.

export type IngestDeps = FetchDeps & {
  now: () => Date;
  gateway: LlmGateway;
  route: Route<JobExtractInput, JobExtract>;
  store: {
    candidates: () => Promise<DedupeCandidate[]>;
    save: (input: {
      fields: JobFields;
      source: JobSourceInput;
      mergeInto: string | null;
    }) => Promise<SaveResult>;
  };
};

export type IngestResult =
  | {
      status: "created" | "merged" | "unchanged";
      jobId: string;
      method: JobSourceInput["method"];
      missing: string[];
      dropped: DroppedField[];
      record: CallRecord | null;
    }
  | { status: "refused"; reason: string }
  | { status: "not_a_job"; record: CallRecord | null }
  | { status: "failed"; reason: string };

export async function ingestUrl(deps: IngestDeps, rawUrl: string): Promise<IngestResult> {
  let url: string;
  try {
    url = canonicalUrl(rawUrl.trim());
  } catch {
    return { status: "refused", reason: "not a valid link" };
  }
  // ADR-0003: never fetched, whatever the link says.
  const terms = termsFor(url);
  if (terms.terms === "prohibited") {
    return {
      status: "refused",
      reason: `${terms.source} doesn't allow automated reading; save the description to a file and use jobs add --text`,
    };
  }
  // Seen before: nothing to fetch, nothing to change.
  const existing = await deps.store.candidates();
  const known = existing.find((j) => j.sources.some((s) => s.url === url));
  if (known) return done({ status: "unchanged", jobId: known.jobId }, "ats_api", [], [], null);

  try {
    const target = detectAts(url);
    const viaApi = target ? await fromAts(deps, target) : null;
    if (viaApi) return store(deps, existing, url, viaApi, [], null);

    const page = await safeFetch(deps, url);
    if (page.status !== 200)
      return { status: "failed", reason: `the page answered ${page.status}` };
    const viaLd = fromJsonLd(page.body);
    if (viaLd) return store(deps, existing, url, withAts(viaLd, target), [], null);

    return await viaModel(deps, existing, url, htmlToText(page.body), "model", target);
  } catch (error) {
    if (error instanceof FetchRefused) return { status: "refused", reason: error.message };
    // A timeout or dropped connection: say so without the page's details.
    // fetch's own network failure is a TypeError "fetch failed"; any other TypeError is a bug and
    // must surface.
    const network =
      error instanceof Error &&
      (error.name === "TimeoutError" ||
        (error.name === "TypeError" && error.message === "fetch failed"));
    if (network) {
      return { status: "failed", reason: "the site didn't answer in time" };
    }
    throw error;
  }
}

// A description Paul saved himself (LinkedIn and other sign-in pages, ADR-0003). `url` records
// where it came from; nothing is fetched.
export async function ingestText(
  deps: IngestDeps,
  rawUrl: string,
  text: string,
): Promise<IngestResult> {
  let url: string;
  try {
    url = canonicalUrl(rawUrl.trim());
  } catch {
    return { status: "refused", reason: "--url isn't a valid link" };
  }
  if (!/^https?:\/\//.test(url))
    return { status: "refused", reason: "--url must be an http(s) link" };
  const existing = await deps.store.candidates();
  const known = existing.find((j) => j.sources.some((s) => s.url === url));
  if (known) return done({ status: "unchanged", jobId: known.jobId }, "text", [], [], null);
  return viaModel(deps, existing, url, text, "text", detectAts(url));
}

async function fromAts(deps: IngestDeps, t: AtsTarget): Promise<Extraction | null> {
  switch (t.ats) {
    case "greenhouse":
      return greenhouse(deps, t);
    case "lever":
      return lever(deps, t);
    case "ashby":
      return ashby(deps, t);
    case "workday":
      return workday(deps, t);
  }
}

// The ATS a URL belongs to, even when its API didn't answer and the page was read instead.
function withAts(x: Extraction, target: AtsTarget | null): Extraction {
  if (!target) return x;
  return {
    ...x,
    ats: target.ats,
    atsPostingId: target.postingId,
    fields: { ...x.fields, ats: target.ats },
  };
}

async function viaModel(
  deps: IngestDeps,
  existing: DedupeCandidate[],
  url: string,
  text: string,
  method: "model" | "text",
  target: AtsTarget | null,
): Promise<IngestResult> {
  const outcome = await deps.gateway.call(deps.route, { url, text });
  if (outcome.kind === "Ok") {
    if (!outcome.output.isJobPosting) return { status: "not_a_job", record: outcome.record };
    const { fields, dropped } = checkJobProvenance(outcome.output, text);
    const x = withAts(
      {
        method,
        ats: null,
        atsPostingId: null,
        fields: { ...fields, description: text.trim() || null },
      },
      target,
    );
    return store(deps, existing, url, x, dropped, outcome.record);
  }
  // Refused, cut off or malformed: never a silent drop (SRC-001). Store a draft for Paul to fill.
  const draft = withAts(
    {
      method,
      ats: null,
      atsPostingId: null,
      fields: { ...emptyFields(), description: text.trim() || null },
    },
    target,
  );
  return store(deps, existing, url, draft, [], outcome.record);
}

async function store(
  deps: IngestDeps,
  existing: DedupeCandidate[],
  url: string,
  x: Extraction,
  dropped: DroppedField[],
  record: CallRecord | null,
): Promise<IngestResult> {
  const source: JobSourceInput = {
    url,
    method: x.method,
    ats: x.ats,
    atsPostingId: x.atsPostingId,
  };
  const match = findDuplicate(existing, x.fields, source);
  const saved = await deps.store.save({
    fields: x.fields,
    source,
    mergeInto: match?.jobId ?? null,
  });
  const missing = [x.fields.title ? null : "title", x.fields.company ? null : "company"].filter(
    (m): m is string => m !== null,
  );
  return done(saved, x.method, saved.status === "created" ? missing : [], dropped, record);
}

function done(
  saved: SaveResult,
  method: JobSourceInput["method"],
  missing: string[],
  dropped: DroppedField[],
  record: CallRecord | null,
): IngestResult {
  return { status: saved.status, jobId: saved.jobId, method, missing, dropped, record };
}
