import { createServer, type Server } from "node:http";
import type { HandoffPackage, HandoffPackageError } from "@northstar/db";
import type { Result } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import { handoffPackageEndpoint } from "./handoff-package.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// The handoff pre-fill's read (NS-192) over a real http server, with packages/db's read faked.
// Synthetic ids, people and links only.
const SIGNIN = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const EXT_TOKEN = "test-extension-token";
const EXT_HASH = "2f50a0607c1fb6606c98272169b134502f7c188b1e17f3d1579320aa3e3fb6c4"; // sha256(EXT_TOKEN)
const WEB = "http://northstar.localhost:3100";
const EXT_ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const HANDOFF = "0b6f3f8e-6a55-4c7e-9a52-5d6b2f8a1c01";

const PACKAGE: HandoffPackage = {
  handoffId: HANDOFF,
  applicationId: "5c1e2a7d-3b4f-4e8a-9c6d-7f0a1b2c3d4e",
  ats: "greenhouse",
  applyUrl: "https://boards.greenhouse.io/example/jobs/123",
  contact: { firstName: "Test", lastName: "Person", email: "test@example.com", phone: null },
  fields: { question_1: "Synthetic answer.", question_2: ["Remote"] },
};

let server: Server;
let sessions: ReturnType<typeof createSessions>;
let reads: string[];
let answer: Result<HandoffPackage, HandoffPackageError>;

beforeEach(async () => {
  reads = [];
  answer = { ok: true, value: PACKAGE };
  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const config: ApiConfig = { signinKeySha256: SIGNIN, port: portOf(server), webOrigin: WEB };
  sessions = createSessions(() => 0);
  server.on(
    "request",
    createApi({
      config,
      sessions,
      extensionTokenSha256: EXT_HASH,
      extra: [
        handoffPackageEndpoint({
          read: async (handoffId) => {
            reads.push(handoffId);
            return answer;
          },
        }),
      ],
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const ask = (body: unknown, headers: Record<string, string> = {}): Promise<Sent> =>
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

describe("POST /handoffs/package: who may call it", () => {
  it("a live session cookie doesn't open it without the extension token", async () => {
    const cookie = `ns_session=${sessions.open().token}`;
    // From the extension's origin, no token: 401. From the web app's own page: refused earlier, 403.
    const fromExtension = await ask({ handoffId: HANDOFF }, { authorization: "", cookie });
    const fromWeb = await ask({ handoffId: HANDOFF }, { authorization: "", cookie, origin: WEB });
    expect([fromExtension.status, fromWeb.status, reads]).toEqual([401, 403, []]);
  });

  it("refuses a wrong token with 401 and reads nothing", async () => {
    const res = await ask({ handoffId: HANDOFF }, { authorization: "Bearer wrong-token" });
    expect([res.status, reads]).toEqual([401, []]);
  });

  it("refuses a handoff id that isn't a uuid before reading anything", async () => {
    const res = await ask({ handoffId: "not-a-uuid" });
    expect([res.status, reads]).toEqual([400, []]);
  });
});

describe("POST /handoffs/package", () => {
  it("answers with the open handoff's approved package", async () => {
    const res = await ask({ handoffId: HANDOFF });
    expect([res.status, JSON.parse(res.body), reads]).toEqual([200, PACKAGE, [HANDOFF]]);
  });

  it.each([
    [{ kind: "NotFound" }, 404, "not_found"],
    [{ kind: "Closed" }, 409, "closed"],
    [{ kind: "NoPackage" }, 409, "no_package"],
    [{ kind: "NotApproved", reason: "Withdrawn" }, 409, "not_approved"],
    [{ kind: "Changed" }, 409, "changed"],
  ] as const)(
    "refuses %o with %i and a fixed code, never the Gate's reason",
    async (error, status, code) => {
      answer = { ok: false, error };
      const res = await ask({ handoffId: HANDOFF });
      expect([res.status, JSON.parse(res.body)]).toEqual([status, { error: code }]);
      expect(res.body).not.toContain("Withdrawn");
    },
  );
});
