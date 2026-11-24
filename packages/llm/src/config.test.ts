import { describe, expect, it } from "vitest";
import { loadLlmConfig } from "./config.js";

describe("loadLlmConfig", () => {
  it("reads the API key", () => {
    expect(loadLlmConfig({ ANTHROPIC_API_KEY: "test-key" })).toEqual({ apiKey: "test-key" });
  });

  it("names the setting when the key is missing, without any value", () => {
    expect(() => loadLlmConfig({})).toThrow("ANTHROPIC_API_KEY is missing");
  });

  it("refuses the .env.example placeholder, so a live run can't start with a fake key", () => {
    expect(() => loadLlmConfig({ ANTHROPIC_API_KEY: "change-me" })).toThrow(
      "ANTHROPIC_API_KEY is still the placeholder",
    );
  });

  it("treats an empty key as missing", () => {
    expect(() => loadLlmConfig({ ANTHROPIC_API_KEY: "" })).toThrow("ANTHROPIC_API_KEY is missing");
  });
});
