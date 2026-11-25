import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import {
  abandonInterview,
  connectDb,
  currentResumeHash,
  loadDbConfig,
  nextAtomForInterview,
  readCurrentThesis,
  readEmploymentFacts,
  readInterviewAnswers,
  readProfile,
  readSourceRoles,
  readStories,
  readThesisProfile,
  recordAnswer,
  recordDraftOutcome,
  recordFactsCheck,
  saveApprovedStory,
  saveApprovedThesis,
  setEmploymentFacts,
  soleCandidate,
  startInterview,
  writeProfileImport,
} from "@northstar/db";
import { createAnthropicClient, createLlmGateway, loadLlmConfig } from "@northstar/llm";
import { sql } from "drizzle-orm";
import { main, safeErrorSummary } from "./cli.js";
import { importResume } from "./import.js";
import { type Choice, runInterview, type Terminal } from "./interview.js";
import { profileExtractRoute } from "./route.js";
import { storyDraftRoute } from "./story-route.js";
import { fileToText } from "./text.js";
import { draftTheses } from "./thesis-draft.js";

// Entry point for `pnpm --filter @northstar/profile profile …`. The only place in this package
// that reads process.env (DATABASE_URL, ANTHROPIC_API_KEY from .env).
const { db, close } = connectDb(loadDbConfig(process.env));
// The model gateway, built only by commands that call the model.
const gateway = () =>
  createLlmGateway({
    client: createAnthropicClient(
      loadLlmConfig({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }),
    ),
    now: () => performance.now(),
  });
// Paul's keyboard, opened only for `interview` (an open readline keeps the process waiting).
let rl: Interface | undefined;
try {
  // Fail before calling the model if the database isn't reachable: no tokens on an import that
  // can't be saved.
  await db.execute(sql`select 1`);
  const candidateId = await soleCandidate(db);
  const exitCode = await main({
    argv: process.argv.slice(2),
    print: (line) => console.log(printable(line)),
    // pnpm runs scripts from the package folder; resolve the path from where Paul ran pnpm.
    readText: (path) => fileToText(resolve(process.env.INIT_CWD ?? process.cwd(), path)),
    runImport: (fileName, text, { reimport }) =>
      importResume(
        {
          gateway: gateway(),
          route: profileExtractRoute(),
          currentHash: () => currentResumeHash(db, candidateId),
          store: (input) => writeProfileImport(db, input),
        },
        { candidateId, fileName, text, reimport },
      ),
    readProfile: () => readProfile(db, candidateId),
    runInterview: (atomId) => {
      rl = createInterface({ input: process.stdin, output: process.stdout });
      return runInterview(
        {
          terminal: readlineTerminal(rl),
          gateway: gateway(),
          route: storyDraftRoute(),
          store: {
            nextAtom: (id) => nextAtomForInterview(db, candidateId, id),
            start: (input) => startInterview(db, { candidateId, ...input }),
            answers: (interviewId) => readInterviewAnswers(db, candidateId, interviewId),
            record: async (input) => {
              await recordAnswer(db, { candidateId, ...input });
            },
            draftOutcome: (input) => recordDraftOutcome(db, { candidateId, ...input }),
            approve: ({ interviewId, draft, promptVersion, model, traceId }) =>
              saveApprovedStory(db, {
                candidateId,
                interviewId,
                story: {
                  title: draft.title,
                  situation: draft.situation.text,
                  task: draft.task.text,
                  action: draft.action.text,
                  result: draft.result.text,
                  competencies: draft.competencies,
                },
                atomIds: draft.atomIds,
                promptVersion,
                model,
                traceId,
              }),
            abandon: (input) => abandonInterview(db, { candidateId, ...input }),
          },
        },
        atomId === undefined ? {} : { atomId },
      );
    },
    readStories: () => readStories(db, candidateId),
    setFacts: (positions) => setEmploymentFacts(db, { candidateId, positions }),
    readFacts: () => readEmploymentFacts(db, candidateId),
    recordCheck: (claims, mismatches) => recordFactsCheck(db, { candidateId, claims, mismatches }),
    readThesisProfile: () => readThesisProfile(db, candidateId),
    // Off until Paul records real fixtures and sets the baseline (ADR-0016 item 8); with it off,
    // no gateway (and no API key) is needed.
    draftTheses: (profile, asOf) =>
      draftTheses(
        { gateway: { call: (route, input) => gateway().call(route, input) }, enabled: false },
        profile,
        asOf,
      ),
    saveThesis: (text, atomIds) => saveApprovedThesis(db, { candidateId, text, atomIds }),
    readThesis: () => readCurrentThesis(db, candidateId),
    month: () => new Date().toISOString().slice(0, 7),
    readLinkedinExport: async (folder) => {
      const dir = resolve(process.env.INIT_CWD ?? process.cwd(), folder);
      const positions = await readOptional(join(dir, "Positions.csv"));
      if (positions === undefined) return null;
      const education = await readOptional(join(dir, "Education.csv"));
      const skills = await readOptional(join(dir, "Skills.csv"));
      return {
        positions,
        ...(education === undefined ? {} : { education }),
        ...(skills === undefined ? {} : { skills }),
      };
    },
    storeImport: (input) => writeProfileImport(db, { ...input, candidateId }),
    readLinkedinRoles: () => readSourceRoles(db, candidateId, "linkedin"),
  });
  process.exitCode = exitCode;
} catch (error) {
  // Never let Node print the raw error: a database error's detail can quote resume text.
  console.error(`profile: ${safeErrorSummary(error)}`);
  process.exitCode = 1;
} finally {
  rl?.close();
  await close();
}

// The interview's terminal on readline. A closed input (Ctrl-D, Ctrl-C) reads as null, which the
// interview treats as "stop; answers so far are saved".
function readlineTerminal(rl: Interface): Terminal {
  // Closing input aborts the question that is waiting, so it settles as null instead of hanging.
  const stop = new AbortController();
  rl.on("close", () => stop.abort());
  // Without a listener, Ctrl-C only pauses readline and a pending question would hang.
  rl.on("SIGINT", () => rl.close());
  const question = async (prompt: string): Promise<string | null> => {
    if (stop.signal.aborted) return null;
    try {
      return await rl.question(printable(prompt), { signal: stop.signal });
    } catch {
      return null;
    }
  };
  return {
    print: (line) => console.log(printable(line)),
    ask: (q) => question(`\n${q}\n> `),
    choose: async (options) => {
      const menu = options.map((o) => `[${o[0]}]${o.slice(1)}`).join(" / ");
      for (;;) {
        const answer = await question(`${menu}? `);
        if (answer === null) return null;
        const picked = options.find((o: Choice) => o[0] === answer.trim().toLowerCase()[0]);
        if (picked) return picked;
      }
    },
  };
}

// Model output, resume text and pasted answers are shown in Paul's terminal: drop control
// characters (escape sequences could rewrite the screen or the window title). Tabs and newlines stay.
function printable(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

// A file's text, or undefined when it doesn't exist (an optional CSV of the LinkedIn export).
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}
