import { describe, expect, it } from "vitest";
import { loadDbConfig, loadMigrationConfig } from "./config.js";

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

  // NS-235: an app never runs with the database owner's credentials in its environment.
  it.each(["DATABASE_MIGRATION_URL", "POSTGRES_PASSWORD", "PGPASSWORD", "PGUSER", "PGPASSFILE"])(
    "refuses to start while %s is set, naming it but never its value",
    (name) => {
      let message = "";
      try {
        loadDbConfig({
          DATABASE_URL: "postgres://northstar_app:test-key@127.0.0.1:5432/northstar_test",
          [name]: "owner-test-key",
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect([message, message.includes("owner-test-key")]).toEqual([
        `${name} is set for an app: the owner's credentials belong only to .env (compose and db:migrate); apps load .env.app`,
        false,
      ]);
    },
  );

  it("treats an empty owner setting as unset", () => {
    expect(
      loadDbConfig({
        DATABASE_URL: "postgres://northstar_app:test-key@127.0.0.1:5432/northstar_test",
        POSTGRES_PASSWORD: "",
      }),
    ).toEqual({ databaseUrl: "postgres://northstar_app:test-key@127.0.0.1:5432/northstar_test" });
  });
});

describe("loadMigrationConfig", () => {
  it("reads the owner's DATABASE_MIGRATION_URL, not the app's DATABASE_URL", () => {
    const config = loadMigrationConfig({
      DATABASE_URL: "postgres://northstar_app:test-key@127.0.0.1:5432/northstar_test",
      DATABASE_MIGRATION_URL: "postgres://northstar:test-key@127.0.0.1:5432/northstar_test",
    });
    expect(config).toEqual({
      databaseUrl: "postgres://northstar:test-key@127.0.0.1:5432/northstar_test",
    });
  });

  it("names DATABASE_MIGRATION_URL when it is missing, even with DATABASE_URL set", () => {
    expect(() =>
      loadMigrationConfig({
        DATABASE_URL: "postgres://northstar_app:test-key@127.0.0.1:5432/northstar_test",
      }),
    ).toThrow(
      "DATABASE_MIGRATION_URL is missing or is not a postgres:// URL (percent-encode # / ? @ % in the password)",
    );
  });
});
