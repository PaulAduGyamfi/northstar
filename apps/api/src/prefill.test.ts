import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { HandoffPackage, HandoffPackageError } from "@northstar/db";
import type { Result } from "@northstar/domain";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import { createPrefillGrants, errorClassOf, GRANT_TTL_MS, prefillEndpoints } from "./prefill.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// The pre-fill grant and the extension's package read (NS-192 slice 2, ADR-0029 option 2) over a
// real http server, with readHandoffPackage faked. Synthetic data only: invented names, example.com.
const SIGNIN = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const EXT_TOKEN = "test-extension-token";
const EXT_HASH = "2f50a0607c1fb6606c98272169b134502f7c188b1e17f3d1579320aa3e3fb6c4"; // sha256(EXT_TOKEN)
const WEB = "http://northstar.localhost:3100";
const EXT_ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const HANDOFF = "0b6f3f8e-6a55-4c7e-9a52-5d6b2f8a1c01";
const OTHER = "1c7a4f9e-7b66-4d8f-8a63-6e7c3a9b2d02";

const PACKAGE: HandoffPackage = {
  handoffId: HANDOFF,
  applicationId: "5c1e2a7d-3b4f-4e8a-9c6d-7f0a1b2c3d4e",
  ats: "greenhouse",
  applyUrl: "https://boards.greenhouse.io/example/jobs/123",
  contact: { firstName: "Jo", lastName: "Example", email: "jo@example.com", phone: null },
  fields: { question_1: "Yes", question_2: ["Remote"] },
};

let server: Server;
let cookie: string;
let clock: number;
let reads: string[];
let outcome: Result<HandoffPackage, HandoffPackageError>;
let grants: ReturnType<typeof createPrefillGrants>;
let prefills: {
  handoffId: string;
  applicationId: string;
  ats: string;
  fieldCount: number;
  grantKey: string;
}[];
let recordWorks: boolean;
let recordThrows: Error | null;

beforeEach(async () => {
  clock = 1_000_000;
  reads = [];
  prefills = [];
  recordWorks = true;
  recordThrows = null;
  outcome = { ok: true, value: PACKAGE };
  grants = createPrefillGrants(() => clock);
  const sessions = createSessions(() => 0);
  cookie = `ns_session=${sessions.open().token}`;
  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const config: ApiConfig = { signinKeySha256: SIGNIN, port: portOf(server), webOrigin: WEB };
  const extra = prefillEndpoints({
    readPackage: async (handoffId) => {
      reads.push(handoffId);
      return handoffId === HANDOFF ? outcome : { ok: false, error: { kind: "NotFound" } };
    },
    recordPrefill: async (input) => {
      if (recordThrows !== null) throw recordThrows;
      if (!recordWorks) return false;
      prefills.push(input);
      return true;
    },
    grants,
  });
  server.on("request", createApi({ config, sessions, extensionTokenSha256: EXT_HASH, extra }));
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

// Paul's click on the card: his session cookie from the web app's origin.
const askGrant = (handoffId: string, headers: Record<string, string> = {}): Promise<Sent> =>
  send(server, {
    method: "POST",
    path: "/handoffs/prefill-grant",
    headers: { "content-type": "application/json", origin: WEB, cookie, ...headers },
    body: JSON.stringify({ handoffId }),
  });

// The extension's read: its own token from its own origin.
const readPackage = (body: unknown, headers: Record<string, string> = {}): Promise<Sent> =>
  send(server, {
    method: "POST",
    path: "/handoffs/package",
    headers: {
      "content-type": "application/json",
      origin: EXT_ORIGIN,
      authorization: `Bearer ${EXT_TOKEN}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });

async function issued(): Promise<string> {
  const res = await askGrant(HANDOFF);
  expect(res.status).toBe(200);
  return (JSON.parse(res.body) as { grant: string }).grant;
}

describe("POST /handoffs/prefill-grant", () => {
  it("issues a grant for an open handoff that the read would serve, good for 2 minutes", async () => {
    const res = await askGrant(HANDOFF);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { grant: string; expiresAt: string };
    expect(body.grant).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBe(new Date(clock + GRANT_TTL_MS).toISOString());
  });

  it.each([
    ["Closed", 409, "closed"],
    ["NoPackage", 409, "no_package"],
    ["NotApproved", 409, "not_approved"],
    ["Changed", 409, "changed"],
  ] as const)(
    "issues nothing for a handoff the read refuses as %s",
    async (kind, status, error) => {
      outcome = {
        ok: false,
        error: kind === "NotApproved" ? { kind, reason: "Withdrawn" } : { kind },
      };
      const res = await askGrant(HANDOFF);
      expect([res.status, JSON.parse(res.body)]).toEqual([status, { error }]);
      expect(grants.keys()).toEqual([]);
    },
  );

  it("refuses a request without Paul's session, the extension token included", async () => {
    const res = await askGrant(HANDOFF, { cookie: "", authorization: `Bearer ${EXT_TOKEN}` });
    expect(res.status).toBe(401);
    expect(reads).toEqual([]);
  });

  it("keeps only a hash of each grant, never the grant itself", async () => {
    const grant = await issued();
    expect(grants.keys()).toHaveLength(1);
    expect(grants.keys()).not.toContain(grant);
    expect(grants.keys()[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("POST /handoffs/package", () => {
  it("serves exactly the re-checked package for a live grant on its own handoff", async () => {
    const grant = await issued();
    reads.length = 0;
    const res = await readPackage({ handoffId: HANDOFF, grant });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(PACKAGE);
    expect(reads).toEqual([HANDOFF]);
  });

  it("refuses the extension token with no grant at all, and reads nothing", async () => {
    const res = await readPackage({ handoffId: HANDOFF });
    expect([res.status, JSON.parse(res.body)]).toEqual([403, { error: "grant_invalid" }]);
    expect(reads).toEqual([]);
  });

  it("refuses the extension token with a made-up grant, and reads nothing", async () => {
    const res = await readPackage({ handoffId: HANDOFF, grant: "x".repeat(43) });
    expect([res.status, JSON.parse(res.body)]).toEqual([403, { error: "grant_invalid" }]);
    expect(reads).toEqual([]);
  });

  it("serves a grant once: the second read with it is refused", async () => {
    const grant = await issued();
    expect((await readPackage({ handoffId: HANDOFF, grant })).status).toBe(200);
    reads.length = 0;
    const again = await readPackage({ handoffId: HANDOFF, grant });
    expect([again.status, JSON.parse(again.body)]).toEqual([403, { error: "grant_invalid" }]);
    expect(reads).toEqual([]);
  });

  it("a grant lasts exactly 2 minutes", () => {
    expect(GRANT_TTL_MS).toBe(120_000);
  });

  it("serves a grant used 1 ms before its 2 minutes are up", async () => {
    const grant = await issued();
    clock += GRANT_TTL_MS - 1;
    expect((await readPackage({ handoffId: HANDOFF, grant })).status).toBe(200);
  });

  it("refuses a grant once its 2 minutes are up, and reads nothing", async () => {
    const grant = await issued();
    reads.length = 0;
    clock += GRANT_TTL_MS;
    const res = await readPackage({ handoffId: HANDOFF, grant });
    expect([res.status, JSON.parse(res.body)]).toEqual([403, { error: "grant_invalid" }]);
    expect(reads).toEqual([]);
  });

  it("refuses a grant issued for another handoff, and uses it up", async () => {
    const grant = await issued();
    reads.length = 0;
    expect((await readPackage({ handoffId: OTHER, grant })).status).toBe(403);
    expect((await readPackage({ handoffId: HANDOFF, grant })).status).toBe(403);
    expect(reads).toEqual([]);
  });

  it("refuses Paul's session cookie without the extension token, before the grant is touched", async () => {
    const grant = await issued();
    reads.length = 0;
    const res = await readPackage({ handoffId: HANDOFF, grant }, { authorization: "", cookie });
    expect(res.status).toBe(401);
    expect(reads).toEqual([]);
    expect((await readPackage({ handoffId: HANDOFF, grant })).status).toBe(200);
  });

  it("puts only a fixed outcome code on the request's span", async () => {
    const exporter = new InMemorySpanExporter();
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
    try {
      const grant = await issued();
      await readPackage({ handoffId: HANDOFF, grant });
      await readPackage({ handoffId: HANDOFF, grant });
      const outcomes = exporter
        .getFinishedSpans()
        .map((s) => s.attributes["northstar.prefill.outcome"]);
      expect(outcomes).toEqual(["issued", "served", "grant_invalid"]);
    } finally {
      trace.disable();
    }
  });

  it("answers the read's refusal when the handoff closed after the grant was issued", async () => {
    const grant = await issued();
    outcome = { ok: false, error: { kind: "Closed" } };
    const res = await readPackage({ handoffId: HANDOFF, grant });
    expect([res.status, JSON.parse(res.body)]).toEqual([409, { error: "closed" }]);
  });

  it("refuses a body larger than a handoff id and a grant", async () => {
    const grant = await issued();
    const res = await readPackage({ handoffId: HANDOFF, grant, padding: "p".repeat(600) });
    expect(res.status).toBe(413);
  });
});

// NS-192 slice 3: handoff.prefilled is written before the package is served.
describe("POST /handoffs/package records the pre-fill", () => {
  it("records ids, the ATS, the field count and a 16-hex grant key, and no value", async () => {
    const grant = await issued();
    const res = await readPackage({ handoffId: HANDOFF, grant });
    expect(res.status).toBe(200);
    expect(prefills).toEqual([
      {
        handoffId: HANDOFF,
        applicationId: PACKAGE.applicationId,
        ats: "greenhouse",
        fieldCount: 2,
        grantKey: createHash("sha256").update(grant).digest("hex").slice(0, 16),
      },
    ]);
  });

  it("serves nothing when the pre-fill can't be recorded", async () => {
    recordWorks = false;
    const grant = await issued();
    const res = await readPackage({ handoffId: HANDOFF, grant });
    expect([res.status, JSON.parse(res.body)]).toEqual([503, { error: "prefill_unrecorded" }]);
  });

  it("puts the failed write's error class, never its message, on the span", async () => {
    const exporter = new InMemorySpanExporter();
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
    try {
      const grant = await issued();
      recordThrows = new TypeError("connection to db-host refused");
      const res = await readPackage({ handoffId: HANDOFF, grant });
      const read = exporter.getFinishedSpans().at(-1);
      expect([
        res.status,
        read?.attributes["northstar.prefill.outcome"],
        read?.attributes["northstar.prefill.record_error"],
      ]).toEqual([503, "prefill_unrecorded", "TypeError"]);
    } finally {
      trace.disable();
    }
  });

  it("records nothing for a refused grant", async () => {
    await readPackage({ handoffId: HANDOFF, grant: "x".repeat(43) });
    expect(prefills).toEqual([]);
  });
});

describe("errorClassOf", () => {
  it("keeps a plain class name and turns anything else into Error", () => {
    const crafted = new Error("x");
    crafted.name = "Bad name: secret";
    expect([
      errorClassOf(new RangeError("x")),
      errorClassOf(crafted),
      errorClassOf("a string"),
      errorClassOf(null),
    ]).toEqual(["RangeError", "Error", "Error", "Error"]);
  });
});

describe("createPrefillGrants", () => {
  it("clears expired grants before dropping a live one", () => {
    let t = 0;
    const store = createPrefillGrants(() => t);
    for (let i = 0; i < 20; i++) store.issue(OTHER);
    t = GRANT_TTL_MS;
    const live = store.issue(HANDOFF).grant;
    expect(store.keys()).toHaveLength(1);
    expect(store.consume(live, HANDOFF)).toBe(true);
  });

  it("drops the oldest grant once 20 are waiting", () => {
    const store = createPrefillGrants(() => 0);
    const first = store.issue(HANDOFF).grant;
    for (let i = 0; i < 20; i++) store.issue(HANDOFF);
    expect(store.keys()).toHaveLength(20);
    expect(store.consume(first, HANDOFF)).toBe(false);
  });
});
