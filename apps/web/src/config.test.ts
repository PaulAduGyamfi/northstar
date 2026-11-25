import { describe, expect, it } from "vitest";
import { loadWebConfig } from "./config";

describe("loadWebConfig", () => {
  it("defaults the API origin to the local API", () => {
    expect(loadWebConfig({})).toEqual({ apiOrigin: "http://127.0.0.1:8787" });
  });

  it("refuses an API origin with a path, naming the setting", () => {
    expect(() => loadWebConfig({ NORTHSTAR_API_ORIGIN: "http://127.0.0.1:8787/v1" })).toThrow(
      "NORTHSTAR_API_ORIGIN must be an http(s) origin such as http://127.0.0.1:8787",
    );
  });
});
