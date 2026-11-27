import { describe, expect, it } from "vitest";
import {
  dotStatus,
  FeedBody,
  type FeedLine,
  feedSubject,
  HealthBody,
  type HealthView,
  mergeFeed,
  readApi,
  switchList,
} from "./system";

// The System Health page's plain logic, against fake API answers. Synthetic subsystems only.
const API = "http://127.0.0.1:8787";
const TOKEN = "A".repeat(43);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fakeFetch = (answer: Response | Error) => {
  const urls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    urls.push(String(input));
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof fetch;
  return { fn, urls };
};

const health = (subsystems: HealthView["subsystems"]): HealthView => ({
  overall: subsystems.every((s) => s.health === "healthy") ? "healthy" : "degraded",
  subsystems,
});

describe("readApi", () => {
  const body = { overall: "healthy", subsystems: [] };

  it("reads a signed-in answer through its schema", async () => {
    const f = fakeFetch(json(200, body));
    const r = await readApi(
      { apiOrigin: API, token: TOKEN, fetch: f.fn },
      "/system/health",
      HealthBody,
    );
    expect(r).toEqual({ kind: "ok", body });
    expect(f.urls).toEqual([`${API}/system/health`]);
  });

  it("is signed out without asking the API when there is no session", async () => {
    const f = fakeFetch(json(200, body));
    const r = await readApi({ apiOrigin: API, token: undefined, fetch: f.fn }, "/x", HealthBody);
    expect(r).toEqual({ kind: "signed_out" });
    expect(f.urls).toEqual([]);
  });

  it("is signed out on 401", async () => {
    const f = fakeFetch(json(401, { error: "unauthenticated" }));
    expect(await readApi({ apiOrigin: API, token: TOKEN, fetch: f.fn }, "/x", HealthBody)).toEqual({
      kind: "signed_out",
    });
  });

  it("passes another status through, such as 503 when the state can't be read", async () => {
    const f = fakeFetch(json(503, { error: "unavailable" }));
    expect(await readApi({ apiOrigin: API, token: TOKEN, fetch: f.fn }, "/x", HealthBody)).toEqual({
      kind: "error",
      status: 503,
    });
  });

  it("is unreachable when the API is down or answers off-schema", async () => {
    for (const answer of [new TypeError("fetch failed"), json(200, { overall: "fine" })]) {
      const f = fakeFetch(answer);
      expect(
        await readApi({ apiOrigin: API, token: TOKEN, fetch: f.fn }, "/x", HealthBody),
      ).toEqual({ kind: "unreachable" });
    }
  });
});

describe("switchList", () => {
  it("always offers the fixed switches, on when nothing switched them", () => {
    expect(switchList(health([]))).toEqual([
      { subsystem: "auto_apply", on: true },
      { subsystem: "outreach_send", on: true },
      { subsystem: "inbox_auto_label", on: true },
    ]);
  });

  it("offers a source switch for each ATS with a watched board, once", () => {
    const list = switchList(
      health([
        {
          subsystem: "board:lever:w2",
          kind: "board",
          health: "healthy",
          reason: "Reading",
          retryAt: null,
        },
        {
          subsystem: "board:greenhouse:w1",
          kind: "board",
          health: "healthy",
          reason: "Reading",
          retryAt: null,
        },
        {
          subsystem: "board:lever:w3",
          kind: "board",
          health: "healthy",
          reason: "Reading",
          retryAt: null,
        },
      ]),
    );
    expect(list.map((s) => s.subsystem)).toEqual([
      "auto_apply",
      "outreach_send",
      "inbox_auto_label",
      "source:greenhouse",
      "source:lever",
    ]);
  });

  it("shows a switched-off subsystem as off, and any other switched one too", () => {
    const list = switchList(
      health([
        {
          subsystem: "auto_apply",
          kind: "switch",
          health: "down",
          reason: "Switched off by you: x",
          retryAt: null,
        },
        {
          subsystem: "agent:mail-classify",
          kind: "switch",
          health: "healthy",
          reason: "Switched on",
          retryAt: null,
        },
      ]),
    );
    expect(list).toEqual([
      { subsystem: "auto_apply", on: false },
      { subsystem: "outreach_send", on: true },
      { subsystem: "inbox_auto_label", on: true },
      { subsystem: "agent:mail-classify", on: true },
    ]);
  });
});

describe("dotStatus", () => {
  it("follows the overall status", () => {
    expect(dotStatus({ kind: "ok", body: health([]) })).toBe("healthy");
    expect(
      dotStatus({
        kind: "ok",
        body: health([
          { subsystem: "gmail", kind: "dependency", health: "down", reason: "x", retryAt: null },
        ]),
      }),
    ).toBe("degraded");
  });

  it("is down when the state can't be read or the API can't be reached", () => {
    expect(dotStatus({ kind: "error", status: 503 })).toBe("down");
    expect(dotStatus({ kind: "unreachable" })).toBe("down");
  });
});

describe("mergeFeed", () => {
  const line = (position: string): FeedLine => ({
    position,
    occurredAt: "2026-11-25T12:00:00.000Z",
    type: "kill_switch.set",
    actor: "user",
    line: `line ${position}`,
    jobTitle: null,
    company: null,
  });

  it("puts new lines on top, newest first", () => {
    const shown = [line("3"), line("2")];
    const incoming = [line("4"), line("5")];
    expect(mergeFeed(shown, incoming, 50).map((l) => l.position)).toEqual(["5", "4", "3", "2"]);
  });

  it("never shows a line twice", () => {
    expect(mergeFeed([line("3")], [line("3"), line("4")], 50).map((l) => l.position)).toEqual([
      "4",
      "3",
    ]);
  });

  it("keeps at most the given number of lines", () => {
    expect(mergeFeed([line("2"), line("1")], [line("3")], 2).map((l) => l.position)).toEqual([
      "3",
      "2",
    ]);
  });
});

describe("FeedBody", () => {
  it("keeps the job title and company the API sends with a line", () => {
    const body = FeedBody.parse({
      items: [
        {
          position: "1",
          occurredAt: "2026-11-25T12:00:00.000Z",
          type: "job.scored",
          actor: "agent:fit",
          line: "Scored a job 91",
          jobTitle: "Backend Engineer",
          company: "Example Corp",
        },
      ],
    });
    expect(body.items.map((i) => [i.jobTitle, i.company])).toEqual([
      ["Backend Engineer", "Example Corp"],
    ]);
  });
});

describe("feedSubject", () => {
  it("shows the title at the company when both are known", () => {
    expect(feedSubject({ jobTitle: "Backend Engineer", company: "Example Corp" })).toBe(
      "Backend Engineer at Example Corp",
    );
  });

  it("shows whichever one is known when the other is missing", () => {
    expect(feedSubject({ jobTitle: "Backend Engineer", company: null })).toBe("Backend Engineer");
    expect(feedSubject({ jobTitle: null, company: "Example Corp" })).toBe("Example Corp");
  });

  it("shows nothing when the line names no job", () => {
    expect(feedSubject({ jobTitle: null, company: null })).toBeNull();
  });
});

describe("HealthBody", () => {
  it("accepts a worker pool's health (NS-225 slice 3)", () => {
    const body = {
      overall: "degraded",
      subsystems: [
        {
          subsystem: "worker:pipeline",
          kind: "worker",
          health: "down",
          reason: "Not running: last seen 10 minutes ago",
          retryAt: null,
        },
      ],
    };
    expect(HealthBody.safeParse(body).success).toBe(true);
  });
});
