import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import {
  connectDb,
  listOpenHandoffs,
  loadDbConfig,
  readDedupeCandidates,
  readFeed,
  readFeedAfter,
  readSystemHealth,
  resolveHandoff,
  saveIngestedJob,
  setKillSwitch,
  soleCandidate,
  transitionApplication,
} from "@northstar/db";
import { ApplicationId } from "@northstar/domain";
import {
  createAnthropicClient,
  createLlmGateway,
  type LlmGateway,
  loadLlmConfig,
} from "@northstar/llm";
import { type IngestDeps, ingestText, ingestUrl, jobExtractRoute } from "@northstar/sources";
import { captureEndpoint } from "./capture.js";
import { loadApiConfig, loadExtensionTokenHash } from "./config.js";
import { handoffEndpoints } from "./handoffs.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { systemEndpoints } from "./system.js";

// Entry point for `pnpm --filter @northstar/api start`. The only place in this app that reads
// process.env. Listens on loopback only: Northstar is local first (NS-156, ADR-0018).
try {
  const config = loadApiConfig(process.env);
  const extensionTokenSha256 = loadExtensionTokenHash(process.env);
  const { db } = connectDb(loadDbConfig(process.env));
  // Paul's candidate row, looked up on the first capture (the pool connects lazily, so sign-in
  // works while Postgres is down). A failed lookup is forgotten, so the next capture tries again.
  let candidate: Promise<Awaited<ReturnType<typeof soleCandidate>>> | undefined;
  const candidateId = () => {
    candidate ??= soleCandidate(db).catch((error: unknown) => {
      candidate = undefined;
      throw error;
    });
    return candidate;
  };
  // Built on first use, as in `jobs add`: a posting read through an ATS API or JSON-LD needs no
  // API key, and the API starts without one.
  let gateway: LlmGateway | undefined;
  const lazyGateway: LlmGateway = {
    call: (route, input) => {
      gateway ??= createLlmGateway({
        client: createAnthropicClient(
          loadLlmConfig({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }),
        ),
        now: () => performance.now(),
      });
      return gateway.call(route, input);
    },
  };
  // The same ingest paths as `jobs add` (packages/sources), so capture follows the same rules.
  const ingest: IngestDeps = {
    resolve: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
    fetch,
    now: () => new Date(),
    gateway: lazyGateway,
    route: jobExtractRoute(),
    store: {
      candidates: async () => readDedupeCandidates(db, await candidateId()),
      save: async (input) => saveIngestedJob(db, { candidateId: await candidateId(), ...input }),
    },
  };
  const capture = captureEndpoint({
    byUrl: (url) => ingestUrl(ingest, url),
    byText: (url, text) => ingestText(ingest, url, text),
  });
  // System Health, the feed and kill switches (NS-153), on packages/db's read paths and its one
  // kill-switch write path. A flip from the app is always Paul's (actor "user", ADR-0002).
  const system = systemEndpoints({
    health: async () => readSystemHealth(db, await candidateId()),
    feedBefore: async (before, limit) => readFeed(db, await candidateId(), { before, limit }),
    feedAfter: async (after, limit) => readFeedAfter(db, await candidateId(), { after, limit }),
    // system.ts sets the actor to Paul; the candidate is always the server's own.
    setSwitch: async (input) => setKillSwitch(db, { ...input, candidateId: await candidateId() }),
  });
  // "Needs your hands" (NS-121) on packages/db's handoff paths. Paul's "I submitted it" moves
  // the application through transitionApplication, the one write path for status changes.
  const handoffs = handoffEndpoints({
    listOpen: async () => listOpenHandoffs(db, await candidateId()),
    resolve: async (handoffId, outcome) =>
      resolveHandoff(db, { candidateId: await candidateId(), handoffId, outcome }),
    markSubmitted: async (applicationId, idempotencyKey) => {
      const moved = await transitionApplication(db, {
        candidateId: await candidateId(),
        applicationId: ApplicationId.parse(applicationId),
        from: "needs_human",
        to: "submitted",
        actor: "user",
        reason: "",
        inputsSummary: "",
        links: [],
        idempotencyKey,
      });
      return { ok: moved.ok };
    },
  });
  const handler = createApi({
    config,
    sessions: createSessions(Date.now),
    extensionTokenSha256,
    extra: [capture, ...system, ...handoffs],
  });
  const server = createServer(handler);
  server.listen(config.port, "127.0.0.1", () => {
    console.log(
      JSON.stringify({
        level: "info",
        msg: "api listening",
        port: config.port,
        extension: extensionTokenSha256 !== null,
      }),
    );
  });
} catch (error) {
  // Config errors name the setting, never its value (config.ts, packages/db's config).
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(JSON.stringify({ level: "error", msg: "api did not start", reason: message }));
  process.exitCode = 1;
}
