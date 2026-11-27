import type { PrepClaim, StoredPrepPlan, VerifyError } from "@northstar/db";
import {
  CandidateId,
  prepEventId,
  prepPlanContentSha256,
  prepPlanSubject,
} from "@northstar/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_APP_CREATED_SCOPE, CalendarWriteAccess } from "./access.js";
import { type CalendarPorts, writePrepPlan } from "./gateway.js";
import { CALENDAR_ID_DOMAIN, NORTHSTAR_CALENDAR_MARKER } from "./requests.js";

// The Calendar writer (NS-241 slice 4, ADR-0031) on fake ports, with the global fetch stubbed as
// Google per test, never the network. Invented ids and a fake token only.

const CANDIDATE = CandidateId.parse("0c9a8b7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d");
const DECISION = "6f0c1b5e-2d4a-4c8e-9b7a-1e2f3a4b5c6d";
const REQUEST = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const PROPOSAL = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const DETECTION = "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f";
const MOVED = "4d5e6f7a-8b9c-4d0e-9f2a-3b4c5d6e7f8a";
const CAL_ID = ["c0ffee12ab", CALENDAR_ID_DOMAIN].join("@");
const API = "https://www.googleapis.com/calendar/v3";
const at = (iso: string) => new Date(iso);
const BLOCKS: StoredPrepPlan["blocks"] = [
  { kind: "prep", start: at("2026-11-30T09:00:00Z"), end: at("2026-11-30T09:45:00Z") },
  { kind: "prep", start: at("2026-12-01T09:00:00Z"), end: at("2026-12-01T09:45:00Z") },
  { kind: "warm_up", start: at("2026-12-01T14:00:00Z"), end: at("2026-12-01T14:15:00Z") },
];
const SHA = prepPlanContentSha256({
  proposalId: PROPOSAL,
  detectionId: DETECTION,
  detectionVersion: 1,
  blocks: BLOCKS,
});
const PLAN: StoredPrepPlan = {
  requestId: REQUEST,
  proposalId: PROPOSAL,
  contentSha256: SHA,
  blocks: BLOCKS,
  filedFor: { detectionId: DETECTION, version: 1 },
  current: { detectionId: DETECTION, version: 1, confirmed: true },
};
const input = { candidateId: CANDIDATE, decisionId: DECISION, requestId: REQUEST };
const access = (scopes = [CALENDAR_APP_CREATED_SCOPE]) =>
  new CalendarWriteAccess("test-token", scopes);

afterEach(() => {
  vi.unstubAllGlobals();
});

type Call = { method: string; url: string; body: string | undefined };

// Google faked: the calendar list holds `listed`, a create answers CAL_ID, and an event id already
// inserted (or in `existing`) answers 409.
function fakeGoogle(opts: { listed?: string | null; existing?: string[] } = {}) {
  const calls: Call[] = [];
  const inserted = new Set(opts.existing ?? []);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = typeof init.body === "string" ? init.body : undefined;
    calls.push({ method: init.method ?? "GET", url, body });
    if (url.startsWith(`${API}/users/me/calendarList`)) {
      const items = opts.listed
        ? [{ id: opts.listed, description: NORTHSTAR_CALENDAR_MARKER }]
        : [{ id: ["other", CALENDAR_ID_DOMAIN].join("@"), description: "Northstar" }];
      return json(200, { items });
    }
    if (url === `${API}/calendars`) return json(200, { id: CAL_ID });
    const id = (JSON.parse(body ?? "{}") as { id: string }).id;
    if (inserted.has(id)) return json(409, { error: { errors: [{ reason: "duplicate" }] } });
    inserted.add(id);
    return json(200, { id });
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, inserted };
}

type Over = {
  plan?: StoredPrepPlan | null;
  refusal?: VerifyError;
  verifiedRequest?: string;
  claim?: PrepClaim;
  calendar?: string | null;
  on?: boolean;
};

function fakePorts(over: Over = {}) {
  const verified: unknown[] = [];
  const withdrawn: unknown[] = [];
  const records: unknown[] = [];
  const saved: string[] = [];
  let calendar = over.calendar ?? null;
  let recorded: number | null = null;
  const ports: CalendarPorts = {
    readPrepPlan: async () => (over.plan === undefined ? PLAN : over.plan),
    verifyApproval: async (v) => {
      verified.push(v);
      if (over.refusal) return { ok: false, error: over.refusal };
      return {
        ok: true,
        value: {
          decisionId: DECISION,
          requestId: over.verifiedRequest ?? REQUEST,
          decidedBy: "user",
          effectiveAt: at("2026-11-27T06:00:00Z"),
        },
      };
    },
    withdrawApproval: async (w) => {
      withdrawn.push(w);
      return {
        ok: true,
        value: { withdrawalId: DECISION, requestId: REQUEST, decisionId: DECISION },
      };
    },
    claimPrepWrite: async () =>
      recorded !== null
        ? { state: "done", blockCount: recorded }
        : (over.claim ?? { state: "new" }),
    recordPrepWrite: async (_c, r) => {
      records.push(r);
      recorded = r.blockCount;
    },
    readNorthstarCalendar: async () => calendar,
    saveNorthstarCalendar: async (_c, id) => {
      saved.push(id);
      calendar = id;
    },
    guard: () => ({
      isOn: async () => over.on ?? true,
      acquire: async () => ({ allowed: true, probe: false }),
      report: async () => {},
    }),
  };
  return { ports, verified, withdrawn, records, saved };
}

const inserts = (calls: Call[]) => calls.filter((c) => c.url.includes("/events?"));

describe("writePrepPlan (NS-241 slice 4, ADR-0031)", () => {
  it.each([
    "NotFound",
    "Rejected",
    "Undone",
    "SubjectMismatch",
    "ContentChanged",
    "Withdrawn",
  ] as const)(
    "sends nothing to Google and claims nothing when the Gate answers %s",
    async (kind) => {
      const google = fakeGoogle();
      const { ports, records } = fakePorts({ refusal: { kind } as VerifyError });
      expect(await writePrepPlan(ports, access(), input)).toEqual({
        ok: false,
        error: { kind: "NotApproved", reason: kind },
      });
      expect([google.calls, records]).toEqual([[], []]);
    },
  );

  it("asks the Gate for this exact plan: kind prep_plan, the proposal's subject and its hash", async () => {
    fakeGoogle();
    const { ports, verified } = fakePorts();
    await writePrepPlan(ports, access(), input);
    expect(verified).toEqual([
      {
        candidateId: CANDIDATE,
        decisionId: DECISION,
        kind: "prep_plan",
        subject: prepPlanSubject(PROPOSAL),
        contentSha256: SHA,
      },
    ]);
  });

  it("waits out the undo window with its end as retryAt, writing nothing", async () => {
    const google = fakeGoogle();
    const effectiveAt = at("2026-11-27T06:02:00Z");
    const { ports } = fakePorts({ refusal: { kind: "UndoWindowOpen", effectiveAt } });
    expect(await writePrepPlan(ports, access(), input)).toEqual({
      ok: false,
      error: { kind: "NotApproved", reason: "UndoWindowOpen", retryAt: effectiveAt },
    });
    expect(google.calls).toEqual([]);
  });

  it("refuses a decision that belongs to another request", async () => {
    const google = fakeGoogle();
    const { ports } = fakePorts({ verifiedRequest: PROPOSAL });
    expect(await writePrepPlan(ports, access(), input)).toEqual({
      ok: false,
      error: { kind: "NotApproved", reason: "RequestMismatch" },
    });
    expect(google.calls).toEqual([]);
  });

  it("refuses a stored plan whose blocks no longer hash to what the request pins", async () => {
    const google = fakeGoogle();
    const tampered = { ...PLAN, blocks: BLOCKS.slice(0, 2) };
    const { ports, verified } = fakePorts({ plan: tampered });
    expect(await writePrepPlan(ports, access(), input)).toEqual({
      ok: false,
      error: { kind: "ContentMismatch" },
    });
    expect([verified, google.calls]).toEqual([[], []]);
  });

  it("answers NotFound for a request with no stored plan", async () => {
    fakeGoogle();
    const { ports } = fakePorts({ plan: null });
    expect(await writePrepPlan(ports, access(), input)).toEqual({
      ok: false,
      error: { kind: "NotFound" },
    });
  });

  it("withdraws the approval with the plan's hash over the new time when the interview moved, writing nothing", async () => {
    const google = fakeGoogle();
    const moved = { ...PLAN, current: { detectionId: MOVED, version: 2, confirmed: false } };
    const { ports, withdrawn, records } = fakePorts({ plan: moved });
    expect(await writePrepPlan(ports, access(), input)).toEqual({
      ok: false,
      error: { kind: "Rescheduled", withdrawn: true },
    });
    expect([withdrawn, google.calls, records]).toEqual([
      [
        {
          candidateId: CANDIDATE,
          requestId: REQUEST,
          by: "gateway",
          newContentSha256: prepPlanContentSha256({
            proposalId: PROPOSAL,
            detectionId: MOVED,
            detectionVersion: 2,
            blocks: BLOCKS,
          }),
        },
      ],
      [],
      [],
    ]);
  });

  it("asks Paul (scope_missing) and sends nothing when the grant lacks calendar.app.created", async () => {
    const google = fakeGoogle();
    const { ports, records } = fakePorts();
    expect(await writePrepPlan(ports, access([]), input)).toEqual({
      ok: true,
      value: { kind: "needs_human", reason: "scope_missing" },
    });
    expect([google.calls, records]).toEqual([[], []]);
  });

  it("creates the Northstar calendar, stores its id and inserts each block with its decision-derived id", async () => {
    const google = fakeGoogle();
    const { ports, records, saved } = fakePorts();
    expect(await writePrepPlan(ports, access(), input)).toEqual({
      ok: true,
      value: { kind: "written", created: 3, existing: 0 },
    });
    expect([
      google.calls.map((c) => c.method),
      inserts(google.calls).map((c) => (JSON.parse(c.body ?? "{}") as { id: string }).id),
      saved,
      records,
    ]).toEqual([
      ["GET", "POST", "POST", "POST", "POST"],
      [0, 1, 2].map((i) => prepEventId(DECISION, i)),
      [CAL_ID],
      [{ decisionId: DECISION, proposalId: PROPOSAL, blockCount: 3 }],
    ]);
  });

  it("uses the stored calendar without looking it up or making another", async () => {
    const google = fakeGoogle();
    const { ports, saved } = fakePorts({ calendar: CAL_ID });
    await writePrepPlan(ports, access(), input);
    expect([
      google.calls.every((c) => c.url.includes("/events?")),
      google.calls.length,
      saved,
    ]).toEqual([true, 3, []]);
  });

  it("after an unknown outcome finds the marked calendar instead of making a second, and counts 409s as written", async () => {
    const google = fakeGoogle({ listed: CAL_ID, existing: [prepEventId(DECISION, 0)] });
    const { ports, saved } = fakePorts({ claim: { state: "unknown" } });
    expect(await writePrepPlan(ports, access(), input)).toEqual({
      ok: true,
      value: { kind: "written", created: 2, existing: 1 },
    });
    expect([google.calls.some((c) => c.url === `${API}/calendars`), saved]).toEqual([
      false,
      [CAL_ID],
    ]);
  });

  it("writes each block once when run twice", async () => {
    const google = fakeGoogle();
    const { ports } = fakePorts();
    const first = await writePrepPlan(ports, access(), input);
    const second = await writePrepPlan(ports, access(), input);
    expect([first.ok && first.value.kind, second, inserts(google.calls).length]).toEqual([
      "written",
      { ok: true, value: { kind: "already_written", blockCount: 3 } },
      3,
    ]);
  });

  it("comes back later while another run holds the claim, sending nothing", async () => {
    const google = fakeGoogle();
    const retryAt = at("2026-11-27T06:05:00Z");
    const { ports } = fakePorts({ claim: { state: "in_progress", retryAt } });
    expect(await writePrepPlan(ports, access(), input)).toEqual({
      ok: false,
      error: { kind: "InProgress", retryAt },
    });
    expect(google.calls).toEqual([]);
  });

  it("is held back, sending nothing, while the calendar_writes kill switch is off", async () => {
    const google = fakeGoogle();
    const { ports, records } = fakePorts({ on: false });
    expect(await writePrepPlan(ports, access(), input)).toEqual({
      ok: false,
      error: { kind: "HeldBack", by: "kill_switch", what: "calendar_writes", retryAt: null },
    });
    expect([google.calls, records]).toEqual([[], []]);
  });
});
