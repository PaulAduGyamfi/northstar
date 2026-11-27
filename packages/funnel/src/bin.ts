import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  acquireCall,
  connectDb,
  countUngradedRecruiterMail,
  type LinkDecision as DbLinkDecision,
  dbSpendMeter,
  dbWindowStore,
  isSubsystemOn,
  knownGmailIds,
  latestFactsCheck,
  loadDbConfig,
  readDeadLetterKeys,
  readFunnelMessages,
  readLinkCandidates,
  readLinkedThreads,
  readMailCursor,
  readManualRows,
  readTags,
  readUnclassifiedMail,
  recordCallOutcome,
  recordDeadLetter,
  recordFunnelEvent,
  recordInterviewDetection,
  recordMailClassification,
  recordMailLink,
  resolveReview,
  saveFunnelMessages,
  saveMailCursor,
  setManualRows,
  soleCandidate,
} from "@northstar/db";
import {
  authorizeCalendar,
  authorizeGmail,
  classifyLinkedMail,
  createCalendarClient,
  createGmailClient,
  googleTokenEndpoint,
  loadGoogleConfig,
  mailClassifyRoute,
  pollFromCursor,
  runInterviewDetection,
} from "@northstar/inbox";
import {
  type CallGuard,
  createAnthropicClient,
  createLlmGateway,
  loadLlmBudget,
  loadLlmConfig,
} from "@northstar/llm";
import { sql } from "drizzle-orm";
import { createAsker } from "./ask.js";
import { runBackfill } from "./backfill.js";
import { main } from "./cli.js";
import { runInbox } from "./inbox.js";
import { toInterviewCandidates } from "./interviews.js";
import { Baselines } from "./report.js";

// Entry point for `pnpm --filter @northstar/funnel funnel …`. The only place in this package that
// reads process.env (DATABASE_URL, GOOGLE_OAUTH_CLIENT_*, ANTHROPIC_API_KEY from .env.app, NS-235). Paul runs
// it; agents never do (it reads his real mail and calendar and prints his real funnel).
const { db, close } = connectDb(loadDbConfig(process.env));
// How far back the very first `funnel inbox` run reads, before a cursor is stored.
const FIRST_RUN_DAYS = 7;
// Paul's keyboard, opened only when `review` asks (an open readline keeps the process waiting).
let asker: ReturnType<typeof createAsker> | undefined;
try {
  // Fail before contacting Google or the model if the database isn't reachable.
  await db.execute(sql`select 1`);
  const candidateId = await soleCandidate(db);
  // The stored kill switches and breakers (NS-174): agent:mail-classify and the anthropic and
  // gmail breakers. Every check reads Postgres, so a switch flipped in the app holds the next call.
  const guard: CallGuard = {
    isOn: (subsystem) => isSubsystemOn(db, candidateId, subsystem),
    acquire: (dependency) => acquireCall(db, { candidateId, dependency }),
    report: async (dependency, outcome, probeToken) => {
      await recordCallOutcome(db, { candidateId, dependency, outcome, probeToken });
    },
  };
  const print = (line: string) => console.log(printable(line));
  // The Claude gateway behind the stored switch and breaker and the LLM spend cap (NS-176,
  // ADR-0021): low routes such as mail-classify pause first, fresh ones run longest.
  const gateway = () =>
    createLlmGateway({
      client: createAnthropicClient(
        loadLlmConfig({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }),
      ),
      now: () => performance.now(),
      guard,
      budget: {
        caps: loadLlmBudget({
          LLM_DAILY_CAP_USD: process.env.LLM_DAILY_CAP_USD,
          LLM_MONTHLY_CAP_USD: process.env.LLM_MONTHLY_CAP_USD,
        }),
        meter: dbSpendMeter(db, () => candidateId),
      },
    });
  // ADR-0014: read-only Gmail consent on this run, the token in memory until the process ends.
  const gmailAccess = () =>
    authorizeGmail({
      config: loadGoogleConfig(process.env),
      fetchToken: googleTokenEndpoint(fetch),
      timeoutMs: 120_000,
      openBrowser: async (url) => {
        print("Opening Google's consent page (read-only Gmail). If it doesn't open, visit:");
        print(url);
        openInBrowser(url);
      },
    });
  // dist/bin.js → the package root, where the committed baselines live.
  const baselines = Baselines.parse(
    JSON.parse(await readFile(new URL("../funnel-baselines.json", import.meta.url), "utf8")),
  );
  process.exitCode = await main({
    argv: process.argv.slice(2),
    print,
    ask: (question) => {
      asker ??= createAsker({ input: process.stdin, output: process.stdout });
      return asker.question(printable(question));
    },
    now: () => new Date(),
    baselines,
    runBackfill: async (options, counts) => {
      const access = await gmailAccess();
      return runBackfill(
        {
          gmail: createGmailClient({
            access,
            fetch,
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            random: Math.random,
            guard,
          }),
          gateway: gateway(),
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
    runInterviews: async () => {
      // ADR-0026: consent on this run, the token in memory until the process ends, never stored.
      const access = await authorizeCalendar({
        config: loadGoogleConfig(process.env),
        fetchToken: googleTokenEndpoint(fetch),
        timeoutMs: 120_000,
        openBrowser: async (url) => {
          print("Opening Google's consent page (read-only Calendar). If it doesn't open, visit:");
          print(url);
          openInBrowser(url);
        },
      });
      // Stays null when the run stops before reading the applications (the calendar read is first).
      let applications: number | null = null;
      let withDomains: number | null = null;
      const report = await runInterviewDetection({
        // Every read goes through the stored `calendar` breaker.
        calendar: createCalendarClient({
          access,
          fetch,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          random: Math.random,
          guard,
        }),
        candidateId,
        candidates: async () => {
          const rows = await readLinkCandidates(db, candidateId);
          applications = rows.length;
          withDomains = rows.filter((r) => (r.companyDomains ?? []).length > 0).length;
          return toInterviewCandidates(rows);
        },
        record: (detection) => recordInterviewDetection(db, { candidateId, detection }),
        deadLetter: (letter) => recordDeadLetter(db, { candidateId, ...letter }),
        now: () => new Date(),
      });
      return { report, applications, withDomains };
    },
    runInbox: async () => {
      const access = await gmailAccess();
      // Every Gmail read goes through the stored `gmail` breaker.
      const gmail = createGmailClient({
        access,
        fetch,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        random: Math.random,
        guard,
      });
      const llm = gateway();
      const route = mailClassifyRoute();
      const windows = dbWindowStore(db, candidateId);
      // INB-002's pre-filter also passes mail from the company domains Paul entered (NS-252).
      const candidates = await readLinkCandidates(db, candidateId);
      const knownDomains = new Set(candidates.flatMap((c) => c.companyDomains ?? []));
      const mailbox = await gmail.profileAddress();
      const letter = async (
        kind: "mail.poll" | "mail.classify",
        input: {
          subject: string;
          reasonCode: string;
          attempts: number;
          gmailMessageId: string;
        },
      ) => {
        const saved = await recordDeadLetter(db, {
          candidateId,
          kind,
          subject: input.subject,
          reasonCode: input.reasonCode,
          attempts: input.attempts,
          idempotencyKey: input.key,
        });
        // A letter that can't be stored stops the run: a silent drop would hide the message.
        if (!saved.ok) throw new Error(`dead letter refused: ${saved.error.field}`);
      };
      return runInbox({
        poll: (skip) =>
          pollFromCursor(
            {
              gmail,
              now: () => new Date(),
              knownDomains,
              mailbox,
              openWindows: () => windows.openWindows(),
              readTags: () => readTags(db, candidateId),
              readCandidates: () => readLinkCandidates(db, candidateId),
              readLinkedThreads: () => readLinkedThreads(db, candidateId),
              record: (input) =>
                recordMailLink(db, {
                  candidateId,
                  ...input,
                  decision: input.decision as DbLinkDecision,
                }),
              cursor: {
                read: () => readMailCursor(db, candidateId),
                save: (c) => saveMailCursor(db, { candidateId, ...c }),
              },
            },
            // The very first run reads the last 7 days; the backfill covers before that.
            { firstSince: new Date(Date.now() - FIRST_RUN_DAYS * 86_400_000), skip },
          ),
        pollLetters: () => readDeadLetterKeys(db, candidateId, "mail.poll"),
        classifyLetters: () => readDeadLetterKeys(db, candidateId, "mail.classify"),
        recordPollLetter: (key, attempts) =>
          letter("mail.poll", {
            // The message has no row yet: the letter is the candidate's.
            subject: `candidate:${candidateId}`,
            reasonCode: "read_failed",
            attempts,
            key,
          }),
        recordClassifyLetter: (m, reason, key) =>
          letter("mail.classify", {
            subject: `mail_link:${m.mailLinkId}`,
            reasonCode: reason,
            attempts: 1,
            key,
          }),
        unclassified: (limit) => readUnclassifiedMail(db, candidateId, limit),
        readFull: (gmailMessageId) => gmail.getFull(gmailMessageId),
        classify: (mail) => classifyLinkedMail({ gateway: llm, route }, mail),
        recordClassification: (gmailMessageId, result) =>
          recordMailClassification(db, { candidateId, gmailMessageId, result }),
        ungradedRecruiterMail: () => countUngradedRecruiterMail(db, candidateId),
      });
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
  asker?.close();
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
