import { resolve } from "node:path";
import {
  connectDb,
  currentResumeHash,
  loadDbConfig,
  readProfile,
  soleCandidate,
  writeProfileImport,
} from "@northstar/db";
import { createAnthropicClient, createLlmGateway, loadLlmConfig } from "@northstar/llm";
import { sql } from "drizzle-orm";
import { main, safeErrorSummary } from "./cli.js";
import { importResume } from "./import.js";
import { profileExtractRoute } from "./route.js";
import { fileToText } from "./text.js";

// Entry point for `pnpm --filter @northstar/profile profile …`. The only place in this package
// that reads process.env (DATABASE_URL, ANTHROPIC_API_KEY from .env).
const { db, close } = connectDb(loadDbConfig(process.env));
try {
  // Fail before calling the model if the database isn't reachable: no tokens on an import that
  // can't be saved.
  await db.execute(sql`select 1`);
  const candidateId = await soleCandidate(db);
  const exitCode = await main({
    argv: process.argv.slice(2),
    print: (line) => console.log(line),
    // pnpm runs scripts from the package folder; resolve the path from where Paul ran pnpm.
    readText: (path) => fileToText(resolve(process.env.INIT_CWD ?? process.cwd(), path)),
    runImport: (fileName, text, { reimport }) =>
      importResume(
        {
          gateway: createLlmGateway({
            client: createAnthropicClient(
              loadLlmConfig({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }),
            ),
            now: () => performance.now(),
          }),
          route: profileExtractRoute(),
          currentHash: () => currentResumeHash(db, candidateId),
          store: (input) => writeProfileImport(db, input),
        },
        { candidateId, fileName, text, reimport },
      ),
    readProfile: () => readProfile(db, candidateId),
  });
  process.exitCode = exitCode;
} catch (error) {
  // Never let Node print the raw error: a database error's detail can quote resume text.
  console.error(`profile: ${safeErrorSummary(error)}`);
  process.exitCode = 1;
} finally {
  await close();
}
