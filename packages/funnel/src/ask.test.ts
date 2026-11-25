import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createAsker } from "./ask.js";

// A fake keyboard: a stream the test writes answers into, or closes.
function keyboard() {
  const input = new PassThrough();
  const output = new PassThrough();
  return { input, output, ask: createAsker({ input, output }) };
}

describe("createAsker", () => {
  it("returns the line typed", async () => {
    const k = keyboard();
    const answer = k.ask.question("> ");
    k.input.write("p\n");
    expect(await answer).toBe("p");
    k.ask.close();
  });

  it("returns null when input closes while a question waits, instead of hanging", async () => {
    const k = keyboard();
    const answer = k.ask.question("> ");
    k.input.end();
    expect(await answer).toBeNull();
  });

  it("returns null at once for a question asked after input closed", async () => {
    const k = keyboard();
    k.input.end();
    await new Promise((r) => setImmediate(r));
    expect(await k.ask.question("> ")).toBeNull();
  });
});
