import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  acquireCall,
  connectDb,
  countUngradedRecruiterMail,
  type LinkDecision as DbLinkDecision,
  dbCalendarLedger,
  dbSpendMeter,
  dbWindowStore,
  fileReplyDraft,
  isSubsystemOn,
  knownGmailIds,
  latestFactsCheck,
  listInterviews,
  loadDbConfig,
  PREFERENCE_DEFAULTS,
  type PreferenceValues,
  proposeInterviewPrep,
  readApprovedPrepPlans,
  readDeadLetterKeys,
  readFunnelMessages,
  readLinkCandidates,
  readLinkedThreads,
  readMailCursor,
  readManualRows,
  readPreferences,
  readPrepPlan,
  readPrepProposal,
  readRecordedMessageIds,
  readReplyCandidates,
  readTags,
  readUnclassifiedMail,
  readUngradedRecruiterMail,
  recordCallOutcome,
  recordDeadLetter,
  recordFunnelEvent,
  recordInterviewDetection,
  recordMailClassification,
  recordMailLink,
  recordRecruiterGrade,
  requestPrepPlanApproval,
  resolveReview,
  saveFunnelMessages,
  saveMailCursor,
  setManualRows,
  soleCandidate,
  verifyApproval,
  withdrawApproval,
} from "@northstar/db";
import {
  authorizeCalendar,
  authorizeGmail,
  classifyLinkedMail,
  createCalendarClient,
  createGmailClient,
  extractRecruiterFacts,
  googleTokenEndpoint,
  isJobMail,
  type LinkStepDeps,
  linkNewMessage,
  loadGoogleConfig,
  mailClassifyRoute,
  pollFromCursor,
  runInterviewDetection,
  tagFromDeliveredTo,
} from "@northstar/inbox";
import {
  type CallGuard,
  createAnthropicClient,
  createLlmGateway,
  loadLlmBudget,
  loadLlmConfig,
} from "@northstar/llm";
import { gradeRecruiterMessage } from "@northstar/sources";
import { sql } from "drizzle-orm";
import { createAsker } from "./ask.js";
import { runBackfill } from "./backfill.js";
import { main } from "./cli.js";
import { loadFunnelConfig, loadPrepConfig, loadRecruiterReplies } from "./config.js";
import { runGrading } from "./grade.js";
import { runInbox } from "./inbox.js";
import { toInterviewCandidates } from "./interviews.js";
import { runPrep } from "./prep.js";
import { runReplies } from "./reply.js";
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
    runPrep: async ({ busyFromCalendar }) => {
      // A bad or missing zone or working hours stops the run before anything is planned.
      const config = loadPrepConfig(process.env);
      return runPrep({
        config,
        now: () => new Date(),
        interviews: () => listInterviews(db, candidateId),
        proposalOf: async (detectionId) => {
          const stored = await readPrepProposal(db, candidateId, detectionId);
          return stored === null ? null : { proposalId: stored.proposalId, blocks: stored.blocks };
        },
        propose: async (detectionId, request) => {
          const proposed = await proposeInterviewPrep(db, { candidateId, detectionId, request });
          return proposed.ok
            ? {
                ok: true,
                value: {
                  proposalId: proposed.value.proposal.proposalId,
                  blocks: proposed.value.proposal.blocks,
                },
              }
            : proposed;
        },
        file: (proposalId) => requestPrepPlanApproval(db, { candidateId, proposalId }),
        approved: () => readApprovedPrepPlans(db, candidateId),
        letters: () => readDeadLetterKeys(db, candidateId, "calendar.prep_write"),
        recordLetter: async (plan, reason, key) => {
          const saved = await recordDeadLetter(db, {
            candidateId,
            kind: "calendar.prep_write",
            subject: `approval_decision:${plan.decisionId}`,
            reasonCode: reason,
            attempts: 1,
            idempotencyKey: key,
          });
          // A letter that can't be stored stops the run: a silent drop would hide the plan.
          if (!saved.ok) throw new Error(`dead letter refused: ${saved.error.field}`);
        },
        // Only with --busy-from-calendar (slice 7): read-only consent on this run (ADR-0026), the
        // token kept in this call alone, and start and end times only out of each event.
        calendarBusy: busyFromCalendar
          ? async (window) => {
              const access = await authorizeCalendar({
                config: loadGoogleConfig(process.env),
                fetchToken: googleTokenEndpoint(fetch),
                timeoutMs: 120_000,
                openBrowser: async (url) => {
                  print(
                    "Opening Google's consent page (read-only Calendar, for your busy time). If it doesn't open, visit:",
                  );
                  print(url);
                  openInBrowser(url);
                },
              });
              // Every read goes through the stored `calendar` breaker.
              const events = await createCalendarClient({
                access,
                fetch,
                sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
                random: Math.random,
                guard,
              }).listEvents(window);
              // A cancelled event isn't busy time; nothing else of an event leaves this function.
              return events
                .filter((e) => e.status !== "cancelled")
                .map((e) => ({ start: e.start, end: e.end }));
            }
          : undefined,
        consent: async () => {
          // Loaded only when an approved plan is waiting, so other funnel commands never load the
          // Calendar writer (or its browser dependency).
          const { authorizeCalendarWrite, writePrepPlan } = await import("@northstar/gateways");
          // ADR-0031: calendar.app.created only, on this run; the token lives in this closure
          // until the process ends and is never stored (#400).
          const access = await authorizeCalendarWrite({
            config: loadGoogleConfig(process.env),
            timeoutMs: 120_000,
            openBrowser: async (url) => {
              print(
                "Opening Google's consent page (your Northstar calendar only). If it doesn't open, visit:",
              );
              print(url);
              openInBrowser(url);
            },
          });
          const ports = {
            readPrepPlan: (owner: typeof candidateId, requestId: string) =>
              readPrepPlan(db, owner, requestId),
            verifyApproval: (input: Parameters<typeof verifyApproval>[1]) =>
              verifyApproval(db, input),
            withdrawApproval: (input: Parameters<typeof withdrawApproval>[1]) =>
              withdrawApproval(db, input),
            ...dbCalendarLedger(db),
            // The stored calendar_writes switch and calendar breaker, asked per request.
            guard: () => guard,
          };
          return (plan) =>
            writePrepPlan(ports, access, {
              candidateId,
              decisionId: plan.decisionId,
              requestId: plan.requestId,
            });
        },
      });
    },
    runInbox: async () => {
      // A bad RECRUITER_EXTRACT stops the run before Google is asked anything.
      const config = loadFunnelConfig(process.env);
      // So does a bad RECRUITER_REPLIES (NS-238 item 2's caller).
      const repliesOn = loadRecruiterReplies(process.env);
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
      // The link step's ports, shared by the poll and the relink of retried messages.
      const step: LinkStepDeps = {
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
      };
      const letter = async (
        kind: "mail.poll" | "mail.classify" | "mail.grade" | "mail.reply",
        input: {
          subject: string;
          reasonCode: string;
          attempts: number;
          key: string;
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
              ...step,
              gmail,
              now: () => new Date(),
              knownDomains,
              cursor: {
                read: () => readMailCursor(db, candidateId),
                save: (c) => saveMailCursor(db, { candidateId, ...c }),
              },
            },
            // The very first run reads the last 7 days; the backfill covers before that.
            { firstSince: new Date(Date.now() - FIRST_RUN_DAYS * 86_400_000), skip },
          ),
        relink: async (gmailMessageId) => {
          const headers = await gmail.getHeaders(gmailMessageId);
          const tag = tagFromDeliveredTo(headers.deliveredTo);
          const tags = new Set((await step.readTags()).map((t) => t.tag));
          // The poll's own rule (INB-002 or a known tag): anything else isn't linked or queued.
          if (isJobMail(headers, knownDomains) || (tag.kind === "tag" && tags.has(tag.tag))) {
            await linkNewMessage(step, headers);
          }
        },
        recorded: (gmailMessageIds) => readRecordedMessageIds(db, candidateId, gmailMessageIds),
        pollLetters: () => readDeadLetterKeys(db, candidateId, "mail.poll"),
        classifyLetters: () => readDeadLetterKeys(db, candidateId, "mail.classify"),
        recordPollLetter: (key, attempts) =>
          letter("mail.poll", {
            // The message has no row yet: the letter is the candidate's.
            subject: `candidate:${candidateId}`,
            // Gmail's own failures never letter (NOT_THE_MESSAGE): this is the step's.
            reasonCode: "step_failed",
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
        // Verification mail left alone (NS-271): the fixed outcome only, never the code.
        recordSkipped: (gmailMessageId) =>
          recordMailClassification(db, {
            candidateId,
            gmailMessageId,
            result: { outcome: "skipped", reason: "verification" },
          }),
        ungradedRecruiterMail: () => countUngradedRecruiterMail(db, candidateId),
        grading: () => {
          // Paul's current search preferences, read once a run (the defaults before he sets any).
          let prefs: Promise<PreferenceValues> | undefined;
          return runGrading({
            enabled: config.recruiterExtract,
            gradeLetters: () => readDeadLetterKeys(db, candidateId, "mail.grade"),
            ungraded: (limit) => readUngradedRecruiterMail(db, candidateId, limit),
            readFull: (gmailMessageId) => gmail.getFull(gmailMessageId),
            // The route behind its switch, the anthropic breaker and the spend cap.
            extract: (body) => extractRecruiterFacts({ gateway: llm, enabled: true }, body),
            grade: async (facts, body) => {
              prefs ??= readPreferences(db, candidateId).then((p) => p ?? PREFERENCE_DEFAULTS);
              // No learned weights: the stored grade stays the grader's own (NS-238 item 3).
              return gradeRecruiterMessage(facts, await prefs, body);
            },
            record: (gmailMessageId, grade) =>
              recordRecruiterGrade(db, { candidateId, gmailMessageId, grade }),
            recordGradeLetter: (m, reason, key) =>
              letter("mail.grade", {
                subject: `mail_link:${m.mailLinkId}`,
                reasonCode: reason,
                attempts: 1,
                key,
              }),
          });
        },
        // Reply drafts by grade: filed with the Gate for Paul's approval, never sent (REC-002).
        replies: async () => {
          // Loaded only when the step is on: the profile package is large, and other commands
          // never need it.
          // Off, runReplies returns before building anything, so the stand-in is never called.
          const build = repliesOn
            ? (await import("@northstar/profile")).recruiterReplyPackage
            : () => ({ ok: false as const, error: { kind: "ArchiveSuggested" as const } });
          return runReplies({
            enabled: repliesOn,
            now: () => new Date(),
            replyLetters: () => readDeadLetterKeys(db, candidateId, "mail.reply"),
            candidates: (since, limit) => readReplyCandidates(db, candidateId, { since, limit }),
            // Headers only, through the same `gmail` breaker; never a body.
            threadMessageIds: (threadId) => gmail.threadMessageIds(threadId),
            getHeaders: (gmailMessageId) => gmail.getHeaders(gmailMessageId),
            getReplyHeaders: (gmailMessageId) => gmail.getReplyHeaders(gmailMessageId),
            build: (input) => build(input),
            file: (reply) => fileReplyDraft(db, { candidateId, reply }),
            recordReplyLetter: (m, reason, key) =>
              letter("mail.reply", {
                subject: `mail_link:${m.mailLinkId}`,
                reasonCode: reason,
                attempts: 1,
                key,
              }),
          });
        },
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
