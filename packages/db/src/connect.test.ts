import { describe, expect, it } from "vitest";
import { poolOptions } from "./connect.js";

// Postgres limits (NS-176, RES-005). No connection is made: only the options are checked.
describe("poolOptions", () => {
  it("bounds the connect and every statement", () => {
    const options = poolOptions({ databaseUrl: "postgres://u:test-key@127.0.0.1:5432/x_test" });
    expect([
      options.connectionTimeoutMillis,
      options.statement_timeout,
      options.query_timeout,
    ]).toEqual([10_000, 60_000, 65_000]);
  });
});
