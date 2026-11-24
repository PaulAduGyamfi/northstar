import { describe, expect, it } from "vitest";
import { loadDbConfig } from "./config.js";

describe("loadDbConfig", () => {
  it("reads a postgres DATABASE_URL", () => {
    const config = loadDbConfig({
      DATABASE_URL: "postgres://northstar:test-key@127.0.0.1:5432/northstar_test",
    });
    expect(config).toEqual({
      databaseUrl: "postgres://northstar:test-key@127.0.0.1:5432/northstar_test",
    });
  });

  it("names the setting when DATABASE_URL is missing", () => {
    expect(() => loadDbConfig({})).toThrow(
      "DATABASE_URL is missing or is not a postgres:// URL (percent-encode # / ? @ % in the password)",
    );
  });

  it("never puts the value in the error, since it may hold a password", () => {
    let message = "";
    try {
      loadDbConfig({ DATABASE_URL: "mysql://northstar:test-key@127.0.0.1/northstar" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      "DATABASE_URL is missing or is not a postgres:// URL (percent-encode # / ? @ % in the password)",
    );
  });
});
