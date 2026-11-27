import { APPLY_ATS } from "@northstar/domain";
import { describe, expect, it } from "vitest";
import { adapterFor } from "./adapters/index.js";

// The extension's pre-fill keeps its own copy of each ATS's hosts and field names, because it
// can't import this package (NS-192 slice 3). This test loads that copy by path and checks it
// against the gateway's adapters, so the two can't drift apart (NS-192 slice 5). It reads source
// only: no browser, no network.

type Contact = { firstName: string; lastName: string; email: string; phone: string | null };
type PrefillAdapter = {
  hosts: readonly string[];
  standard: (c: Contact) => Record<string, string>;
  files: string[];
};

// A path the compiler doesn't follow: the extension is another package with its own build.
const EXTENSION_PREFILL = new URL("../../../../apps/extension/src/prefill.ts", import.meta.url)
  .href;
const loadExtension = async () =>
  (
    (await import(/* @vite-ignore */ EXTENSION_PREFILL)) as {
      ADAPTERS: Record<string, PrefillAdapter>;
    }
  ).ADAPTERS;

const WITH_PHONE: Contact = {
  firstName: "Jo",
  lastName: "Example",
  email: "jo@example.com",
  phone: "+1 555 0100",
};
const NO_PHONE: Contact = { ...WITH_PHONE, phone: null };

describe("the extension's pre-fill table", () => {
  it("covers exactly the ATSes the gateway has adapters for", async () => {
    expect(Object.keys(await loadExtension()).sort()).toEqual([...APPLY_ATS].sort());
  });

  it("uses each gateway adapter's own hosts", async () => {
    const ext = await loadExtension();
    expect(APPLY_ATS.map((ats) => [ats, ext[ats]?.hosts])).toEqual(
      APPLY_ATS.map((ats) => [ats, adapterFor(ats).hosts]),
    );
  });

  it("fills the same contact fields as the gateway, with and without a phone", async () => {
    const ext = await loadExtension();
    const both = (f: (c: Contact) => Record<string, string>) => [f(WITH_PHONE), f(NO_PHONE)];
    expect(APPLY_ATS.map((ats) => [ats, both((c) => ext[ats]?.standard(c) ?? {})])).toEqual(
      APPLY_ATS.map((ats) => [ats, both((c) => adapterFor(ats).standardFields(c))]),
    );
  });

  it("guards the same file fields the gateway uploads to", async () => {
    const ext = await loadExtension();
    const gatewayFiles = (ats: (typeof APPLY_ATS)[number]) => {
      const a = adapterFor(ats);
      return [a.resumeField, ...(a.coverLetterField === null ? [] : [a.coverLetterField])];
    };
    expect(APPLY_ATS.map((ats) => [ats, ext[ats]?.files])).toEqual(
      APPLY_ATS.map((ats) => [ats, gatewayFiles(ats)]),
    );
  });
});
