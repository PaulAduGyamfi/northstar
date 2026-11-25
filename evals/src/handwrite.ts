import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createLlmGateway,
  createRecordingClient,
  DEFAULT_MODEL,
  type MessagesClient,
  requestKey,
} from "@northstar/llm";
import type { EvalReport, RegisteredEval } from "./types.js";

// Hand-written fixtures for a new route (ADR-0016 item 8, NS-135). An agent can't call the model
// (`--record` costs money and is Paul's), so it writes the outputs it expects by hand. They are
// saved through the same recorder as `--record`, so each fixture's key is the real request's, and
// each file says it is hand-written. Paul replaces them with real recordings and sets the
// baseline; until then the route stays off.

type Message = Awaited<ReturnType<MessagesClient["create"]>>;

// A response as the API would shape it, carrying one hand-written output. Zero tokens: nothing
// was spent.
function handwrittenMessage(output: unknown, index: number): Message {
  return {
    id: `msg_handwritten_${index}`,
    type: "message",
    role: "assistant",
    model: DEFAULT_MODEL,
    content: [{ type: "text", text: JSON.stringify(output), citations: null }],
    container: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as unknown as Message;
}

// Runs the eval with the outputs in case order and saves one fixture per case, marked with
// `note`. Returns the report, so the caller sees how the hand-written outputs grade.
export async function writeHandwrittenFixtures(
  evalSet: RegisteredEval,
  cases: readonly unknown[],
  outputs: readonly unknown[],
  fixturesDir: string,
  note: string,
): Promise<EvalReport> {
  if (outputs.length !== cases.length) {
    throw new Error(`${cases.length} case(s) but ${outputs.length} hand-written output(s)`);
  }
  // Never over a real recording: a made-up output replaying as the model's would let a route
  // pass a baseline the model never earned (ADR-0016 item 8: never faked).
  const recorded = existsSync(fixturesDir)
    ? readdirSync(fixturesDir).filter(
        (f) =>
          f.endsWith(".json") &&
          !("handWritten" in JSON.parse(readFileSync(join(fixturesDir, f), "utf8"))),
      )
    : [];
  if (recorded.length > 0) {
    throw new Error(
      `${recorded.length} recorded fixture(s) here: hand-written ones can't replace them`,
    );
  }
  const keys: string[] = [];
  const fake: MessagesClient = {
    async create(params) {
      const index = keys.length;
      keys.push(requestKey(params));
      return handwrittenMessage(outputs[index], index);
    },
  };
  const gateway = createLlmGateway({
    client: createRecordingClient(fake, fixturesDir),
    now: () => 0,
  });
  const report = await evalSet.run(gateway, cases);
  for (const key of keys) {
    const path = join(fixturesDir, `${key}.json`);
    const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const marked = {
      requestSha256: file.requestSha256,
      handWritten: note,
      response: file.response,
    };
    writeFileSync(path, `${JSON.stringify(marked, null, 2)}\n`);
  }
  return report;
}
