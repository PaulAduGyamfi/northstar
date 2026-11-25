import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  connectDb,
  listJobs,
  loadDbConfig,
  readDedupeCandidates,
  saveIngestedJob,
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
import { main } from "./cli.js";
import { type IngestDeps, ingestText, ingestUrl } from "./ingest.js";
import { jobExtractRoute } from "./job-extract-route.js";

// Entry point for `pnpm --filter @northstar/sources jobs …`. The only place in this package that
// reads process.env (DATABASE_URL, and ANTHROPIC_API_KEY only when a page needs the model).
const { db, close } = connectDb(loadDbConfig(process.env));
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
  });
} catch (error) {
  // Never let Node print the raw error: a database error's detail can quote a row.
  console.error(`jobs: ${error instanceof Error ? error.name : "an unknown error"}`);
  process.exitCode = 1;
} finally {
  await close();
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
