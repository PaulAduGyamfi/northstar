import { describe, expect, it } from "vitest";
import { loadEmbedConfig } from "./config.js";

// Job embeddings' settings (NS-129, ADR-0033). Invented keys only.

describe("loadEmbedConfig (NS-129)", () => {
  it("is off when JOB_EMBEDDINGS is unset or off, whatever the key says", () => {
    expect(loadEmbedConfig({})).toEqual({ enabled: false });
    expect(loadEmbedConfig({ JOB_EMBEDDINGS: "off", OPENAI_API_KEY: "test-key" })).toEqual({
      enabled: false,
    });
  });

  it("is on with a key when JOB_EMBEDDINGS is on", () => {
    expect(loadEmbedConfig({ JOB_EMBEDDINGS: "on", OPENAI_API_KEY: "test-key" })).toEqual({
      enabled: true,
      apiKey: "test-key",
    });
  });

  it("refuses on without a key, with the placeholder, or any other flag, naming the setting", () => {
    expect(() => loadEmbedConfig({ JOB_EMBEDDINGS: "on" })).toThrow(
      "JOB_EMBEDDINGS is on but OPENAI_API_KEY is missing",
    );
    expect(() => loadEmbedConfig({ JOB_EMBEDDINGS: "on", OPENAI_API_KEY: "change-me" })).toThrow(
      "OPENAI_API_KEY is still the placeholder",
    );
    expect(() => loadEmbedConfig({ JOB_EMBEDDINGS: "yes" })).toThrow(
      "JOB_EMBEDDINGS must be on or off",
    );
  });

  it("never puts the key's value in an error", () => {
    const error = (() => {
      try {
        loadEmbedConfig({ JOB_EMBEDDINGS: "maybe", OPENAI_API_KEY: "test-key-value" });
      } catch (e) {
        return String(e);
      }
      return "";
    })();
    expect(error).not.toContain("test-key-value");
  });
});
