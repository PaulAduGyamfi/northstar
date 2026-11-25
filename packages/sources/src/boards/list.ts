import { z } from "zod";
import { AshbyJob, fromAshby } from "../ats/ashby.js";
import { fromGreenhouse, GreenhousePosting, safeJson } from "../ats/greenhouse.js";
import { fromLever, LeverPosting } from "../ats/lever.js";
import { dateOrNull, type Extraction, emptyFields, htmlToText, remoteFrom } from "../extraction.js";
import { BOARD_MAX_BYTES, type FetchDeps, safeFetch } from "../fetch.js";
import type { BoardTarget } from "./detect.js";

// One request per board (SRC-003, ADR-0015): each ATS's public listing returns every open posting
// with its content, so a poll never needs a request per posting and never calls the model.

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

export async function listBoard(deps: FetchDeps, t: Board): Promise<BoardPosting[]> {
  const enc = encodeURIComponent(t.board);
  switch (t.ats) {
    case "greenhouse": {
      const body = await read(
        deps,
        `https://boards-api.greenhouse.io/v1/boards/${enc}/jobs?content=true&pay_transparency=true`,
        z.object({ jobs: z.array(z.unknown()) }),
      );
      return each(body.jobs, GreenhousePosting, (p) => ({
        url: `https://boards.greenhouse.io/${t.board}/jobs/${p.id}`,
        extraction: fromGreenhouse(p),
      }));
    }
    case "lever": {
      const body = await read(
        deps,
        `https://api.lever.co/v0/postings/${enc}?mode=json`,
        z.array(z.unknown()),
      );
      return each(body, LeverPosting, (p) => ({
        url: `https://jobs.lever.co/${t.board}/${p.id.toLowerCase()}`,
        extraction: fromLever(p, t.board),
      }));
    }
    case "ashby": {
      const body = await read(
        deps,
        `https://api.ashbyhq.com/posting-api/job-board/${enc}?includeCompensation=true`,
        z.object({ jobs: z.array(z.unknown()) }),
      );
      return each(body.jobs, AshbyJob, (p) => ({
        url: `https://jobs.ashbyhq.com/${t.board}/${p.id.toLowerCase()}`,
        extraction: fromAshby(p, t.board),
      }));
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

async function read<T>(deps: FetchDeps, url: string, shape: z.ZodType<T>): Promise<T> {
  const res = await safeFetch(deps, url, { maxBytes: BOARD_MAX_BYTES });
  if (res.status !== 200) throw new BoardUnavailable(`the board answered ${res.status}`);
  const parsed = shape.safeParse(safeJson(res.body));
  if (!parsed.success) {
    throw new BoardUnavailable("the board's response didn't have the expected shape");
  }
  return parsed.data;
}

// Maps each posting that matches its schema; one malformed posting doesn't sink the board.
function each<S extends z.ZodTypeAny>(
  items: unknown[],
  schema: S,
  map: (p: z.infer<S>) => BoardPosting,
): BoardPosting[] {
  return items.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [map(parsed.data)] : [];
  });
}

// SmartRecruiters' public postings list (api.smartrecruiters.com). No description in the list.
const SrPosting = z.object({
  id: z.string(),
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
    // Shortcodes are per account: scope them like Workday's requisition ids (SRC-006).
    atsPostingId: `${account}/${p.shortcode}`,
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
