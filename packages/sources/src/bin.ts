import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  addWatch,
  connectDb,
  dbSpendMeter,
  dueWatches,
  listJobs,
  listWatches,
  loadDbConfig,
  readAlertCandidates,
  readAlertSettings,
  readAtomTexts,
  readCompanyDomains,
  readDedupeCandidates,
  readFitScore,
  readJobAtsSources,
  readJobsToCheck,
  readPreferences,
  readScorableJobs,
  readScoreKeys,
  readScoringProfile,
  recordAlertHeld,
  recordFreshAlert,
  recordPostingCheck,
  recordRescore,
  removeWatch,
  retryWatch,
  saveFitScore,
  saveIngestedJob,
  saveJobForm,
  savePollResult,
  savePreferences,
  setAlertSettings,
  setCompanyDomain,
  setJobField,
  soleCandidate,
  withdrawClosedApplications,
} from "@northstar/db";
import {
  createAnthropicClient,
  createLlmGateway,
  type LlmGateway,
  loadLlmBudget,
  loadLlmConfig,
} from "@northstar/llm";
import { sql } from "drizzle-orm";
import {
  AlertSettingError,
  alertPass,
  freshSince,
  loadAlertConfig,
  scoreThenAlert,
} from "./alerts.js";
import { readGreenhouseForm } from "./ats/greenhouse-form.js";
import { main } from "./cli.js";
import { scorePending } from "./fit/run.js";
import { type IngestDeps, ingestText, ingestUrl } from "./ingest.js";
import { jobExtractRoute } from "./job-extract-route.js";
import { checkPass } from "./liveness.js";
import { pollDue } from "./poll.js";
import { dbPollGuard } from "./poll-guard.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Entry point for `pnpm --filter @northstar/sources jobs …`. The only place in this package that
// reads process.env (DATABASE_URL, and ANTHROPIC_API_KEY only when a page needs the model; from
// .env.app, NS-235).
const { db, close } = connectDb(loadDbConfig(process.env));
// The LLM spend caps, read at startup so a bad value shows at once (NS-176, ADR-0021).
const llmBudget = loadLlmBudget({
  LLM_DAILY_CAP_USD: process.env.LLM_DAILY_CAP_USD,
  LLM_MONTHLY_CAP_USD: process.env.LLM_MONTHLY_CAP_USD,
});
// Set on `jobs run`'s first wait (waitOrStop below). Declared before main runs: a `let` declared
// later in the module isn't initialized yet while the top-level await is still running.
let stop: AbortController | undefined;
try {
  // Fail before fetching anything if the database isn't reachable.
  await db.execute(sql`select 1`);
  const candidateId = await soleCandidate(db);
  // Built on first use, so a job read through an ATS API or JSON-LD needs no API key.
  let gateway: LlmGateway | undefined;
  const lazyGateway: LlmGateway = {
    call: (route, input) => {
      gateway ??= createLlmGateway({
        client: createAnthropicClient(
          loadLlmConfig({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }),
        ),
        now: () => performance.now(),
        // The route's agent:<route> switch and the anthropic breaker (NS-174), on the same
        // stored switches and breakers board polling uses.
        guard: dbPollGuard(db, candidateId),
        budget: {
          // The LLM spend cap (NS-176, ADR-0021): low routes pause first, fresh ones run longest.
          caps: llmBudget,
          meter: dbSpendMeter(db, () => candidateId),
        },
      });
      return gateway.call(route, input);
    },
  };
  const deps: IngestDeps = {
    resolve: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
    fetch,
    now: () => new Date(),
    gateway: lazyGateway,
    route: jobExtractRoute(),
    store: {
      candidates: () => readDedupeCandidates(db, candidateId),
      save: (input) => saveIngestedJob(db, { candidateId, ...input }),
    },
  };
  // Fresh-job alerts (NS-163): settings read once, refused by name when bad.
  const alertConfig = loadAlertConfig(
    process.env,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  if (!alertConfig.ok) throw new AlertSettingError(alertConfig.setting);
  const defaults = alertConfig.value;
  const alerts = () => {
    // One clock for the pass: the read's window and every decision use the same now.
    const now = new Date();
    return alertPass(
      {
        // Only jobs that could still alert (NS-199): fresh ones and held ones.
        candidates: () => readAlertCandidates(db, candidateId, freshSince(now)),
        watches: () => listWatches(db, candidateId),
        alert: (input) => recordFreshAlert(db, { ...input, candidateId }),
        hold: (input) => recordAlertHeld(db, { ...input, candidateId }),
        // Paul's stored settings over the ALERT_* defaults, read each pass (NS-199 slice 2).
        settings: () => readAlertSettings(db, candidateId),
      },
      now,
      defaults,
    );
  };
  // One scoring pass over the current preferences and resume import (NS-116), then the alert
  // pass over what it scored (NS-163).
  const scoreOnly = () =>
    scorePending({
      preferences: () => readPreferences(db, candidateId),
      profile: () => readScoringProfile(db, candidateId),
      jobs: () => readScorableJobs(db, candidateId),
      keys: (preferenceId, profileSourceId) =>
        readScoreKeys(db, { candidateId, preferenceId, profileSourceId }),
      save: (input) => saveFitScore(db, { ...input, candidateId, now: new Date() }),
    });
  const score = () =>
    scoreThenAlert(scoreOnly, alerts, (name) =>
      console.log(`Alerts didn't run (${name}); the next pass retries.`),
    );
  process.exitCode = await main({
    argv: process.argv.slice(2),
    print: (line) => console.log(printable(line)),
    now: () => new Date(),
    addUrl: (url) => ingestUrl(deps, url),
    addText: (url, text) => ingestText(deps, url, text),
    // pnpm runs scripts from the package folder; resolve the path from where Paul ran pnpm.
    readText: (path) => readFile(resolve(process.env.INIT_CWD ?? process.cwd(), path), "utf8"),
    list: () => listJobs(db, candidateId),
    set: (jobId, field, value) => setJobField(db, { candidateId, jobId, field, value }),
    alerts: {
      defaults,
      read: () => readAlertSettings(db, candidateId),
      save: (change) => setAlertSettings(db, { candidateId, change }),
    },
    // A company's own mail domains, entered by Paul (NS-252).
    domains: {
      read: () => readCompanyDomains(db, candidateId),
      save: (companyId, domain, action) =>
        setCompanyDomain(db, { candidateId, companyId, domain, action }),
    },
    // A saved Greenhouse job's form (NS-227), read through the same safe fetcher as `jobs add`.
    form: {
      sources: (jobId) => readJobAtsSources(db, candidateId, jobId),
      readGreenhouse: (t) => readGreenhouseForm(deps, t),
      save: (jobId, questions) =>
        saveJobForm(db, { candidateId, jobId, ats: "greenhouse", questions, actor: "user" }),
    },
    // Liveness (NS-173, SRC-010): jobs not tried in a day, at most 50 a pass.
    check: () =>
      checkPass(
        {
          resolve: deps.resolve,
          fetch,
          guard: dbPollGuard(db, candidateId),
          store: {
            due: (now) =>
              readJobsToCheck(db, candidateId, {
                checkedBefore: new Date(now.getTime() - DAY_MS),
                // A closed job is re-checked weekly, so a wrong closure can come back.
                closedCheckedBefore: new Date(now.getTime() - 7 * DAY_MS),
                limit: 50,
              }),
            record: (job, outcome) =>
              recordPostingCheck(db, { candidateId, jobId: job.jobId, ats: job.ats, outcome }),
            withdrawClosed: () => withdrawClosedApplications(db, candidateId),
          },
        },
        new Date(),
      ),
    boards: {
      add: (target, tier) =>
        addWatch(db, {
          candidateId,
          now: new Date(),
          watch: { ats: target.ats, board: target.board, url: target.url, tier },
        }),
      list: () => listWatches(db, candidateId),
      remove: (watchId) => removeWatch(db, { candidateId, watchId, now: new Date() }),
      retry: (watchId) => retryWatch(db, { candidateId, watchId, now: new Date() }),
      poll: () =>
        pollDue(
          {
            resolve: deps.resolve,
            fetch,
            // Each ATS's kill switch and breaker, `source:<ats>` (RES-008, RES-002).
            guard: dbPollGuard(db, candidateId),
            store: {
              due: (now) => dueWatches(db, candidateId, now),
              candidates: deps.store.candidates,
              save: deps.store.save,
              record: (w, now, result, next) =>
                savePollResult(db, { candidateId, watchId: w.id, now, result, next }),
            },
          },
          new Date(),
        ),
      wait: (ms) => waitOrStop(ms),
    },
    fit: {
      preferences: () => readPreferences(db, candidateId),
      savePreferences: (values) => savePreferences(db, { candidateId, values, now: new Date() }),
      score,
      recordRescore: (preference, counts) =>
        recordRescore(db, { candidateId, preference, counts, now: new Date() }),
      why: (jobId) => readFitScore(db, { candidateId, jobId }),
      atomTexts: (ids) => readAtomTexts(db, { candidateId, ids }),
    },
  });
} catch (error) {
  // Never let Node print the raw error: a database error's detail can quote a row.
  console.error(
    error instanceof AlertSettingError
      ? `jobs: the ${error.setting} setting isn't valid; see the example settings file.`
      : `jobs: ${error instanceof Error ? error.name : "an unknown error"}`,
  );
  process.exitCode = 1;
} finally {
  await close();
}

// `jobs run`'s pause between passes. Ctrl-C ends the pause and the loop; the handler is only
// installed once `jobs run` first waits, so Ctrl-C exits every other command as usual.
async function waitOrStop(ms: number): Promise<boolean> {
  if (!stop) {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    stop = controller;
  }
  if (stop.signal.aborted) return false;
  try {
    await sleep(ms, undefined, { signal: stop.signal });
    return true;
  } catch {
    return false;
  }
}

// Titles and companies come from web pages (untrusted): drop control, direction and zero-width
// characters so a name can't rewrite or reorder Paul's terminal. Tabs and newlines stay.
function printable(text: string): string {
  return text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g,
    "",
  );
}
