import type { ProfileSettingView } from "@northstar/db";
import { describe, expect, it } from "vitest";
import {
  answerCommand,
  type SettingsDeps,
  settingsSetCommand,
  settingsShowCommand,
} from "./settings-cli.js";

// `profile settings` and `profile answer` (NS-141). Fakes only; synthetic values.

function fake(settings: ProfileSettingView[] = []) {
  const printed: string[] = [];
  const saved: unknown[][] = [];
  const uses: unknown[] = [];
  const d: SettingsDeps = {
    print: (line) => printed.push(line),
    setSetting: async (...args) => {
      saved.push(args);
      return { ok: true, value: { saved: true } };
    },
    readSettings: async () => settings,
    recordFactualUse: async (use) => {
      uses.push(use);
    },
  };
  return { d, printed, saved, uses };
}

describe("profile settings set", () => {
  it("saves a normalized value with its qualifier", async () => {
    const { d, saved } = fake();
    const code = await settingsSetCommand(d, "work_authorization", "Y", "Canada");
    expect([code, saved]).toEqual([0, [["work_authorization", "yes", "Canada"]]]);
  });

  it("refuses a bad value and saves nothing", async () => {
    const { d, printed, saved } = fake();
    const code = await settingsSetCommand(d, "portfolio_url", "http://example.com");
    expect([code, saved, printed]).toEqual([
      1,
      [],
      ["Not saved: portfolio_url takes an https:// link with no user name or password."],
    ]);
  });

  it("refuses a keyed field without --for", async () => {
    const { d, saved } = fake();
    const code = await settingsSetCommand(d, "years_of_experience", "5");
    expect([code, saved]).toEqual([1, []]);
  });

  it("refuses an unknown field", async () => {
    const { d, saved } = fake();
    const code = await settingsSetCommand(d, "favorite_color", "blue");
    expect([code, saved]).toEqual([1, []]);
  });
});

describe("profile settings show", () => {
  it("prints each setting with its qualifier", async () => {
    const { d, printed } = fake([
      { field: "notice_period", qualifier: "", value: "2 weeks" },
      { field: "years_of_experience", qualifier: "Go", value: "6" },
    ]);
    await settingsShowCommand(d);
    expect(printed).toEqual(["notice_period: 2 weeks", "years_of_experience (Go): 6"]);
  });
});

describe("profile answer", () => {
  it("prints the answer, the canonical question and the setting, and records the use", async () => {
    const { d, printed, uses } = fake([
      { field: "years_of_experience", qualifier: "Go", value: "6" },
    ]);
    const code = await answerCommand(d, "How many years of experience do you have with Go?");
    expect([code, printed[0], printed[2], uses.length]).toEqual([
      0,
      "6",
      "From: years_of_experience (Go)",
      1,
    ]);
  });

  it("records no use when the question goes unanswered", async () => {
    const { d, uses } = fake();
    const code = await answerCommand(d, "Tell us about yourself.");
    expect([code, uses]).toEqual([1, []]);
  });
});

describe("profile settings usage", () => {
  it("prints the settings usage for a malformed settings command", async () => {
    const { main } = await import("./cli.js");
    const printed: string[] = [];
    const d = { argv: ["settings", "set"], print: (l: string) => printed.push(l) };
    expect(await main(d as unknown as Parameters<typeof main>[0])).toBe(1);
    expect(printed).toEqual([
      'usage: profile settings set <field> <value> [--for <qualifier>] | profile settings show | profile answer "<question>"',
    ]);
  });
});
