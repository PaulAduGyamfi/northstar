import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The permissions Paul grants when he loads the extension (extension.md: minimal permissions).
const manifest = JSON.parse(
  readFileSync(new URL("../static/manifest.json", import.meta.url), "utf8"),
);

describe("manifest.json", () => {
  it("asks only for activeTab, scripting and storage", () => {
    expect(manifest.permissions).toEqual(["activeTab", "scripting", "storage"]);
  });

  it("can reach only the local API, on any port", () => {
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*"]);
  });

  it("runs nothing in the background or on pages by itself", () => {
    expect(manifest.background).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
  });

  it("is a Manifest V3 extension", () => {
    expect(manifest.manifest_version).toBe(3);
  });
});
