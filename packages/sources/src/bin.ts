import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  addWatch,
  connectDb,
  dueWatches,
  listJobs,
  listWatches,
  loadDbConfig,
  readAlertCandidates,
  readAtomTexts,
  readDedupeCandidates,
  readFitScore,
  readPreferences,
  readScorableJobs,
  readScoreKeys,
  readScoringProfile,
  recordAlertHeld,
  recordFreshAlert,
  recordRescore,
  removeWatch,
  retryWatch,
  saveFitScore,
  saveIngestedJob,
  savePollResult,
  savePreferences,
  setJobField,
  soleCandidate,
} from "@northstar/db";
import {
  createAnthropicClient,
  createLlmGateway,
  type LlmGateway,
  loadLlmConfig,
} from "@northstar/llm";
import { sql } from "drizzle-orm";
import { AlertSettingError, alertPass, loadAlertConfig, scoreThenAlert } from "./alerts.js";
import { main } from "./cli.js";
import { scorePending } from "./fit/run.js";
import { type IngestDeps, ingestText, ingestUrl } from "./ingest.js";
import { jobExtractRoute } from "./job-extract-route.js";
import { pollDue } from "./poll.js";
import { dbPollGuard } from "./poll-guard.js";

// Entry point for `pnpm --filter @northstar/sources jobs …`. The only place in this package that
// reads process.env (DATABASE_URL, and ANTHROPIC_API_KEY only when a page needs the model).
const { db, close } = connectDb(loadDbConfig(process.env));
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
  const alerts = () =>
    alertPass(
      {
        candidates: () => readAlertCandidates(db, candidateId),
        watches: () => listWatches(db, candidateId),
        alert: (input) => recordFreshAlert(db, { ...input, candidateId }),
        hold: (input) => recordAlertHeld(db, { ...input, candidateId }),
      },
      new Date(),
      alertConfig.value,
    );
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
