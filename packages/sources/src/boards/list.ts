import { z } from "zod";
import { AshbyJob, fromAshby } from "../ats/ashby.js";
import { fromGreenhouse, GreenhousePosting, safeJson } from "../ats/greenhouse.js";
import { fromLever, LeverPosting } from "../ats/lever.js";
import { postedOn } from "../ats/workday.js";
import { dateOrNull, type Extraction, emptyFields, htmlToText, remoteFrom } from "../extraction.js";
import { BOARD_MAX_BYTES, type FetchDeps, safeFetch } from "../fetch.js";
import type { BoardTarget } from "./detect.js";

// One request per board (SRC-003, ADR-0015): each ATS's public listing returns every open posting
// with its content, so a poll never needs a request per posting and never calls the model.

// A board with more open postings than this is read up to here (tens of thousands would stall the
// pass); the rest wait for a later ticket.
export const MAX_POSTINGS = 2_000;

// Posting ids go into links and dedupe keys: only each ATS's own id shape is accepted.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS = /^\d{1,20}$/;

export type BoardPosting = {
  // The posting's canonical link, the same one `jobs add` would store for it.
  url: string;
  extraction: Extraction;
};

// The board can't be read this time (an error status, or JSON in a shape we don't know). The
// poll backs the board off; the message is plain words, never the response body.
export class BoardUnavailable extends Error {
  override name = "BoardUnavailable";
}

type Board = Pick<BoardTarget, "ats" | "board">;

// `now` dates Workday's relative "Posted 3 Days Ago" (the other ATSs give dates).
export async function listBoard(
  deps: FetchDeps,
  t: Board,
  now: Date = new Date(),
): Promise<BoardPosting[]> {
  const enc = encodeURIComponent(t.board);
  switch (t.ats) {
    case "workday":
      return listWorkday(deps, t.board, now);
    case "greenhouse": {
      const body = await read(
        deps,
        `https://boards-api.greenhouse.io/v1/boards/${enc}/jobs?content=true&pay_transparency=true`,
        z.object({ jobs: z.array(z.unknown()) }),
      );
      return each(body.jobs, GreenhousePosting, (p) => ({
        url: `https://boards.greenhouse.io/${t.board}/jobs/${p.id}`,
        extraction: withCompany(fromGreenhouse(p), t.board),
      }));
    }
    case "lever": {
      const body = await read(
        deps,
        `https://api.lever.co/v0/postings/${enc}?mode=json`,
        z.array(z.unknown()),
      );
      return each(
        body,
        LeverPosting.refine((p) => UUID.test(p.id)),
        (p) => ({
          url: `https://jobs.lever.co/${t.board}/${p.id.toLowerCase()}`,
          extraction: fromLever(p, t.board),
        }),
      );
    }
    case "ashby": {
      const body = await read(
        deps,
        `https://api.ashbyhq.com/posting-api/job-board/${enc}?includeCompensation=true`,
        z.object({ jobs: z.array(z.unknown()) }),
      );
      return each(
        body.jobs,
        AshbyJob.refine((p) => UUID.test(p.id)),
        (p) => ({
          url: `https://jobs.ashbyhq.com/${t.board}/${p.id.toLowerCase()}`,
          extraction: fromAshby(p, t.board),
        }),
      );
    }
    case "smartrecruiters": {
      // Up to 100 postings per page; a company with more lists its newest first.
      const body = await read(
        deps,
        `https://api.smartrecruiters.com/v1/companies/${enc}/postings?limit=100`,
        z.object({ content: z.array(z.unknown()) }),
      );
      return each(body.content, SrPosting, (p) => ({
        url: `https://jobs.smartrecruiters.com/${t.board}/${p.id}`,
        extraction: fromSmartRecruiters(p),
      }));
    }
    case "workable": {
      const body = await read(
        deps,
        `https://apply.workable.com/api/v1/widget/accounts/${enc}?details=true`,
        z.object({ name: z.string().optional(), jobs: z.array(z.unknown()) }),
      );
      return each(body.jobs, WorkableJob, (p) => ({
        url: `https://apply.workable.com/${t.board}/j/${p.shortcode}`,
        extraction: fromWorkable(p, t.board, body.name ?? null),
      }));
    }
  }
}

// A stored Workday board: `<tenant>.wd<N>/<site>`, as detectBoard writes it (NS-260).
const WORKDAY_BOARD = /^([a-z0-9-]{1,63})\.(wd\d{1,3})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/;
// A posting's path on its site: /job/<segments>/<title>_<requisition id>. Each segment starts with
// a letter or digit, so no `..` and no other host can be spliced into the link.
const WORKDAY_PATH =
  /^\/job\/(?:[A-Za-z0-9][A-Za-z0-9._~%-]*\/)*[A-Za-z0-9][A-Za-z0-9._~%-]*_([A-Za-z0-9-]{1,40})$/;
// Workday's search returns at most 20 postings a page; one page a poll (one request per board).
const WORKDAY_PAGE = 20;

// One posting in the career site's public job search (`/wday/cxs/<tenant>/<site>/jobs`). The search
// has no description: the title, place and age only, like SmartRecruiters' list.
const WorkdayPosting = z.object({
  title: z.string(),
  externalPath: z.string().regex(WORKDAY_PATH),
  locationsText: z.string().optional(),
  postedOn: z.string().optional(),
  remoteType: z.string().optional(),
});

async function listWorkday(deps: FetchDeps, board: string, now: Date): Promise<BoardPosting[]> {
  const m = WORKDAY_BOARD.exec(board);
  const [, tenant, dc, site] = m ?? [];
  if (!tenant || !dc || !site) {
    throw new BoardUnavailable("the stored Workday board isn't tenant.wdN/site");
  }
  const host = `${tenant}.${dc}.myworkdayjobs.com`;
  // The first page of open postings in Workday's own order, with no search or filter: exactly what
  // the career site asks for when anyone opens it. No sign-in, no apply.
  const body = await read(
    deps,
    `https://${host}/wday/cxs/${tenant}/${site}/jobs`,
    z.object({ jobPostings: z.array(z.unknown()) }),
    { appliedFacets: {}, limit: WORKDAY_PAGE, offset: 0, searchText: "" },
  );
  return each(body.jobPostings, WorkdayPosting, (p) => {
    const location = p.locationsText ?? null;
    const reqId = WORKDAY_PATH.exec(p.externalPath)?.[1] ?? "";
    return {
      url: `https://${host}/${site}${p.externalPath}`,
      extraction: {
        method: "ats_api",
        ats: "workday",
        // Scoped by tenant, exactly as detectAts reads it from the posting's link (SRC-006).
        atsPostingId: `${tenant}/${reqId}`,
        fields: {
          ...emptyFields(),
          title: p.title,
          // The search names no company: the tenant stands in, as Lever's board slug does.
          company: tenant,
          location,
          remote: remoteFrom(p.remoteType, location),
          ats: "workday",
          postedAt: postedOn(p.postedOn, now),
        },
      },
    };
  });
}

async function read<T>(
  deps: FetchDeps,
  url: string,
  shape: z.ZodType<T>,
  json?: unknown,
): Promise<T> {
  const res = await safeFetch(deps, url, { maxBytes: BOARD_MAX_BYTES, json });
  if (res.status !== 200) throw new BoardUnavailable(`the board answered ${res.status}`);
  const parsed = shape.safeParse(safeJson(res.body));
  if (!parsed.success) {
    throw new BoardUnavailable("the board's response didn't have the expected shape");
  }
  return parsed.data;
}

// Maps each posting that matches its schema, up to MAX_POSTINGS. A posting that doesn't match, or
// whose mapping throws, is skipped: one malformed posting doesn't sink the board.
function each<S extends z.ZodTypeAny>(
  items: unknown[],
  schema: S,
  map: (p: z.infer<S>) => BoardPosting,
): BoardPosting[] {
  return items.slice(0, MAX_POSTINGS).flatMap((item) => {
    const parsed = schema.safeParse(item);
    if (!parsed.success) return [];
    try {
      return [map(parsed.data)];
    } catch {
      return [];
    }
  });
}

// SmartRecruiters' public postings list (api.smartrecruiters.com). No description in the list.
const SrPosting = z.object({
  id: z.string().regex(DIGITS),
  name: z.string(),
  releasedDate: z.string().optional(),
  company: z.object({ name: z.string().optional() }).optional(),
  location: z
    .object({
      city: z.string().optional(),
      region: z.string().optional(),
      country: z.string().optional(),
      remote: z.boolean().optional(),
    })
    .optional(),
  experienceLevel: z.object({ label: z.string().optional() }).optional(),
});

function fromSmartRecruiters(p: z.infer<typeof SrPosting>): Extraction {
  const loc = p.location;
  const location = place(loc?.city, loc?.region, loc?.country?.toUpperCase());
  return {
    method: "ats_api",
    ats: "smartrecruiters",
    atsPostingId: p.id,
    fields: {
      ...emptyFields(),
      title: p.name,
      company: p.company?.name ?? null,
      location,
      // The flag is explicit either way, so false means on site.
      remote: loc?.remote === true ? "remote" : loc?.remote === false ? "onsite" : null,
      seniority: p.experienceLevel?.label ?? null,
      ats: "smartrecruiters",
      postedAt: dateOrNull(p.releasedDate),
    },
  };
}

// Workable's public jobs widget (apply.workable.com/api/v1/widget/accounts/<account>).
const WorkableJob = z.object({
  title: z.string(),
  shortcode: z.string().regex(/^[A-Za-z0-9]{1,40}$/),
  telecommuting: z.boolean().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  published_on: z.string().optional(),
  created_at: z.string().optional(),
  description: z.string().optional(),
});

function fromWorkable(
  p: z.infer<typeof WorkableJob>,
  account: string,
  name: string | null,
): Extraction {
  const location = place(p.city, p.state, p.country);
  return {
    method: "ats_api",
    ats: "workable",
    // Shortcodes are per account: scope them like Workday's requisition ids (SRC-006). Workable
    // accounts are lower-case subdomains, so the typed case doesn't split one board in two.
    atsPostingId: `${account.toLowerCase()}/${p.shortcode}`,
    fields: {
      ...emptyFields(),
      title: p.title,
      company: name,
      location,
      remote: p.telecommuting ? "remote" : remoteFrom(location),
      ats: "workable",
      description: p.description ? htmlToText(p.description) || null : null,
      postedAt: dateOrNull(p.published_on ?? p.created_at),
    },
  };
}

// "City, Region, Country" from whichever parts are present.
function place(...parts: (string | undefined)[]): string | null {
  const present = parts.map((p) => p?.trim()).filter((p): p is string => Boolean(p));
  return present.length > 0 ? present.join(", ") : null;
}

// A listing that omits the company name gets the board's own name, as Lever and Ashby always do:
// without it every polled job would be a draft.
function withCompany(x: Extraction, board: string): Extraction {
  return x.fields.company ? x : { ...x, fields: { ...x.fields, company: board } };
}
