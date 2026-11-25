import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import {
  connectDb,
  knownGmailIds,
  latestFactsCheck,
  loadDbConfig,
  readFunnelMessages,
  readManualRows,
  recordFunnelEvent,
  resolveReview,
  saveFunnelMessages,
  setManualRows,
  soleCandidate,
} from "@northstar/db";
import {
  authorizeGmail,
  createGmailClient,
  googleTokenEndpoint,
  loadGoogleConfig,
  mailClassifyRoute,
} from "@northstar/inbox";
import { createAnthropicClient, createLlmGateway, loadLlmConfig } from "@northstar/llm";
import { sql } from "drizzle-orm";
import { runBackfill } from "./backfill.js";
import { main } from "./cli.js";
import { Baselines } from "./report.js";

// Entry point for `pnpm --filter @northstar/funnel funnel …`. The only place in this package that
// reads process.env (DATABASE_URL, GOOGLE_OAUTH_CLIENT_*, ANTHROPIC_API_KEY from .env). Paul runs
// it; agents never do (it reads his real mail and prints his real funnel).
const { db, close } = connectDb(loadDbConfig(process.env));
let rl: Interface | undefined;
try {
  // Fail before contacting Google or the model if the database isn't reachable.
  await db.execute(sql`select 1`);
  const candidateId = await soleCandidate(db);
  // dist/bin.js → the package root, where the committed baselines live.
  const baselines = Baselines.parse(
    JSON.parse(await readFile(new URL("../funnel-baselines.json", import.meta.url), "utf8")),
  );
  const print = (line: string) => console.log(printable(line));
  process.exitCode = await main({
    argv: process.argv.slice(2),
    print,
    ask: async (question) => {
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(printable(question));
      } catch {
        return null;
      }
    },
    now: () => new Date(),
    baselines,
    runBackfill: async (options, counts) => {
      const access = await authorizeGmail({
        config: loadGoogleConfig(process.env),
        fetchToken: googleTokenEndpoint(fetch),
        timeoutMs: 120_000,
        openBrowser: async (url) => {
          print("Opening Google's consent page (read-only Gmail). If it doesn't open, visit:");
          print(url);
          openInBrowser(url);
        },
      });
      return runBackfill(
        {
          gmail: createGmailClient({
            access,
            fetch,
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            random: Math.random,
          }),
          gateway: createLlmGateway({
            client: createAnthropicClient(
              loadLlmConfig({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }),
            ),
            now: () => performance.now(),
          }),
          route: mailClassifyRoute(),
          store: {
            knownIds: (ids) => knownGmailIds(db, candidateId, ids),
            save: async (m) => {
              await saveFunnelMessages(db, candidateId, [m]);
            },
            messages: () => readFunnelMessages(db, candidateId),
          },
          print,
        },
        options,
        counts,
      );
    },
    // pnpm runs scripts from the package folder; resolve the path from where Paul ran pnpm.
    readText: (path) => readFile(resolve(process.env.INIT_CWD ?? process.cwd(), path), "utf8"),
    setManualRows: (input) => setManualRows(db, { candidateId, ...input }),
    readMessages: () => readFunnelMessages(db, candidateId),
    readManualRows: () => readManualRows(db, candidateId),
    latestFactsCheck: () => latestFactsCheck(db, candidateId),
    resolveReview: (messageId, decision) => resolveReview(db, { candidateId, messageId, decision }),
    recordEvent: (type, reason, payload) =>
      recordFunnelEvent(db, { candidateId, type, reason, payload }),
  });
} catch (error) {
  // Never let Node print the raw error: a database error's detail can quote a row.
  console.error(`funnel: ${error instanceof Error ? error.name : "an unknown error"}`);
  process.exitCode = 1;
} finally {
  rl?.close();
  await close();
}

// Best effort: the URL is printed too. execFile passes it as one argument, with no shell.
function openInBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "/usr/bin/open"
      : process.platform === "win32"
        ? // A full path: Windows searches the current folder first, so a bare name could pick up
          // a planted program.
          `${process.env.SystemRoot ?? "C:\\Windows"}\\explorer.exe`
        : "xdg-open";
  execFile(command, [url], () => {});
}

// Company and role names come from emails (untrusted): drop control characters before they reach
// Paul's terminal, so an escape sequence can't rewrite the screen. Tabs and newlines stay.
function printable(text: string): string {
  // Also invisible direction and zero-width characters, so an email's name can't reorder a line.
  return text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g,
    "",
  );
}
