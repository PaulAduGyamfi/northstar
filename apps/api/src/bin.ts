import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import {
  acquireCall,
  connectDb,
  dbSpendMeter,
  isSubsystemOn,
  listApplications,
  listOpenHandoffs,
  listPasskeys,
  listTenants,
  loadDbConfig,
  readApplicationTimeline,
  readDedupeCandidates,
  readFeed,
  readFeedAfter,
  readPasskey,
  readPreferences,
  readScorableJobs,
  readScoreKeys,
  readScoringProfile,
  readSystemHealth,
  recordCallOutcome,
  recordPasskeyUse,
  resolveHandoff,
  saveFitScore,
  saveIngestedJob,
  savePasskey,
  setKillSwitch,
  soleCandidate,
} from "@northstar/db";
import {
  type CallGuard,
  createAnthropicClient,
  createLlmGateway,
  type LlmGateway,
  loadLlmBudget,
  loadLlmConfig,
} from "@northstar/llm";
import {
  type IngestDeps,
  ingestText,
  ingestUrl,
  jobExtractRoute,
  scorePending,
} from "@northstar/sources";
import { accountsEndpoints } from "./accounts.js";
import { dbApprovalPorts } from "./approval-ports.js";
import { approvalEndpoints } from "./approvals.js";
import { captureEndpoint } from "./capture.js";
import { loadApiConfig, loadExtensionTokenHash } from "./config.js";
import { markHandoffSubmitted } from "./handoff-ports.js";
import { handoffEndpoints } from "./handoffs.js";
import { passkeyEndpoints } from "./passkeys.js";
import { pipelineEndpoints } from "./pipeline.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { systemEndpoints } from "./system.js";

// Entry point for `pnpm --filter @northstar/api start`. The only place in this app that reads
// process.env. Listens on loopback only: Northstar is local first (NS-156, ADR-0018).
try {
  const config = loadApiConfig(process.env);
  const extensionTokenSha256 = loadExtensionTokenHash(process.env);
  const { db } = connectDb(loadDbConfig(process.env));
  // The LLM spend caps, read at startup so a bad value shows at once (NS-176, ADR-0021).
  const llmBudget = loadLlmBudget({
    LLM_DAILY_CAP_USD: process.env.LLM_DAILY_CAP_USD,
    LLM_MONTHLY_CAP_USD: process.env.LLM_MONTHLY_CAP_USD,
  });
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
  // The stored kill switches and breakers (NS-206): agent:job-extract and the anthropic breaker,
  // read from Postgres on every call. A held-back call answers 503 (capture.ts), never a 500.
  const guard: CallGuard = {
    isOn: async (subsystem) => isSubsystemOn(db, await candidateId(), subsystem),
    acquire: async (dependency) =>
      acquireCall(db, { candidateId: await candidateId(), dependency }),
    report: async (dependency, outcome, probeToken) => {
      await recordCallOutcome(db, {
        candidateId: await candidateId(),
        dependency,
        outcome,
        probeToken,
      });
    },
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
        guard,
        budget: {
          // The LLM spend cap (NS-176, ADR-0021): low routes pause first, fresh ones run longest.
          caps: llmBudget,
          meter: dbSpendMeter(db, candidateId),
        },
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
    // The same scoring pass `jobs add` runs after saving (NS-186), on the same packages/db paths.
    score: async () => {
      const owner = await candidateId();
      return scorePending({
        preferences: () => readPreferences(db, owner),
        profile: () => readScoringProfile(db, owner),
        jobs: () => readScorableJobs(db, owner),
        keys: (preferenceId, profileSourceId) =>
          readScoreKeys(db, { candidateId: owner, preferenceId, profileSourceId }),
        save: (input) => saveFitScore(db, { ...input, candidateId: owner, now: new Date() }),
      });
    },
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
    markSubmitted: async (applicationId, idempotencyKey) =>
      markHandoffSubmitted(db, await candidateId(), applicationId, idempotencyKey),
  });
  // Employer accounts (NS-124), read-only from the tenant registry.
  const accounts = accountsEndpoints({
    listTenants: async () => listTenants(db, await candidateId()),
  });
  // The approval queue (NS-139): the only path to decideApprovals and undoDecision, behind
  // Paul's session, so every decision is his (ADR-0002).
  const approvals = approvalEndpoints(dbApprovalPorts(db, candidateId));
  // The pipeline board and application timeline (NS-168), read-only.
  const pipeline = pipelineEndpoints({
    list: async () => listApplications(db, await candidateId()),
    timeline: async (id) => readApplicationTimeline(db, await candidateId(), id),
  });
  // One set of sessions for the sign-in key and passkeys, so both open the same kind of session
  // and their failures count toward one throttle (ADR-0022).
  const sessions = createSessions(Date.now);
  // Passkey sign-in (NS-178) on packages/db's passkey write path.
  const passkeys = passkeyEndpoints({
    config,
    sessions,
    now: Date.now,
    store: {
      list: async () => listPasskeys(db, await candidateId()),
      read: async (credentialId) => readPasskey(db, await candidateId(), credentialId),
      save: async (input) => savePasskey(db, { ...input, candidateId: await candidateId() }),
      recordUse: async (passkeyId, signCount) =>
        recordPasskeyUse(db, await candidateId(), passkeyId, signCount),
    },
  });
  const handler = createApi({
    config,
    sessions,
    extensionTokenSha256,
    extra: [capture, ...system, ...handoffs, ...accounts, ...approvals, ...pipeline, ...passkeys],
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
