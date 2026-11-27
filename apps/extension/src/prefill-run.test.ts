import { describe, expect, it, vi } from "vitest";
import type { FillDocument } from "./prefill.js";
import { fillForm, fillTarget } from "./prefill.js";
import {
  BAD_CODE_MESSAGE,
  type PrefillPorts,
  parsePrefillCode,
  runPrefill,
} from "./prefill-run.js";

// The popup's "Fill this form" (NS-192 slice 4) on fakes: no browser, no network. Invented ids,
// a made-up grant and example hosts only.

const HANDOFF = "0b6f3f8e-6a55-4c7e-9a52-5d6b2f8a1c01";
const GRANT = "g".repeat(43);
const CODE = `${HANDOFF}.${GRANT}`;
const APPLY = "https://boards.greenhouse.io/example/jobs/123";

const PKG = {
  handoffId: HANDOFF,
  applicationId: "5c1e2a7d-3b4f-4e8a-9c6d-7f0a1b2c3d4e",
  ats: "greenhouse",
  applyUrl: APPLY,
  contact: { firstName: "Jo", lastName: "Example", email: "jo@example.com", phone: null },
  fields: { question_1: "Yes" },
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function ports(over: Partial<PrefillPorts> = {}) {
  const base: PrefillPorts = {
    settings: async () => ({
      ok: true,
      settings: { apiOrigin: "http://127.0.0.1:8787", token: "test-token" },
    }),
    fetch: async () => json(200, PKG),
    activeTab: async () => ({ id: 7, url: `${APPLY}/` }),
    inject: async () => ({ filled: 4, skipped: 0 }),
  };
  const merged = { ...base, ...over };
  // Every port is a spy, so each test can check what was (and wasn't) called.
  return {
    settings: vi.fn(merged.settings),
    fetch: vi.fn(merged.fetch),
    activeTab: vi.fn(merged.activeTab),
    inject: vi.fn(merged.inject),
  };
}

describe("parsePrefillCode", () => {
  it("reads the handoff id and grant from a pasted code, ignoring surrounding spaces", () => {
    expect(parsePrefillCode(`  ${CODE}\n`)).toEqual({ handoffId: HANDOFF, grant: GRANT });
  });

  it("refuses anything that isn't exactly a UUID, a dot and a 43-character grant", () => {
    expect(
      [
        "",
        GRANT,
        HANDOFF,
        `${HANDOFF}.${GRANT}x`,
        `${HANDOFF}.${"g".repeat(42)}`,
        `${HANDOFF}.${"g".repeat(42)}=`,
        `${HANDOFF} ${GRANT}`,
        `x${CODE}`,
      ].map(parsePrefillCode),
    ).toEqual([null, null, null, null, null, null, null, null]);
  });
});

describe("runPrefill", () => {
  it("sends nothing and says so when the code is malformed", async () => {
    const p = ports();
    expect(await runPrefill("not a code", p)).toBe(BAD_CODE_MESSAGE);
    expect([p.settings.mock.calls.length, p.fetch.mock.calls.length]).toEqual([0, 0]);
  });

  it("sends nothing when the extension's settings are missing", async () => {
    const p = ports({
      settings: async () => ({ ok: false, message: "Paste the extension token first." }),
    });
    expect(await runPrefill(CODE, p)).toBe(
      "Paste the extension token first. Open the extension's options.",
    );
    expect(p.fetch).not.toHaveBeenCalled();
  });

  it("sends the code's handoff id and grant once to the package endpoint", async () => {
    const p = ports();
    await runPrefill(CODE, p);
    expect(p.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = p.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect([url, init.body]).toEqual([
      "http://127.0.0.1:8787/handoffs/package",
      JSON.stringify({ handoffId: HANDOFF, grant: GRANT }),
    ]);
  });

  it("shows the API's refusal in plain words and fills nothing", async () => {
    const p = ports({ fetch: async () => json(409, { error: "closed" }) });
    expect(await runPrefill(CODE, p)).toBe("That handoff is already closed.");
    expect(p.inject).not.toHaveBeenCalled();
  });

  it("fills nothing and says so when the API's answer isn't a package", async () => {
    const p = ports({ fetch: async () => json(200, { ats: "greenhouse", fields: {} }) });
    expect(await runPrefill(CODE, p)).toBe("Northstar couldn't pre-fill this form.");
    expect(p.inject).not.toHaveBeenCalled();
  });

  it("says the API is unreachable when the request fails", async () => {
    const p = ports({
      fetch: async () => {
        throw new TypeError("network");
      },
    });
    expect(await runPrefill(CODE, p)).toBe("Couldn't reach Northstar. Is the API running?");
  });

  it("reads the tab after the package arrives and refuses a tab off the application's page", async () => {
    const p = ports({ activeTab: async () => ({ id: 7, url: "https://jobs.lever.co/example/1" }) });
    expect(await runPrefill(CODE, p)).toBe(
      "This tab isn't on the application's own site, so nothing was filled.",
    );
    expect(p.inject).not.toHaveBeenCalled();
  });

  it("says there is no form to fill, and injects nothing, when Chrome can't report the tab", async () => {
    const p = ports({
      activeTab: async () => {
        throw new Error("tabs unavailable");
      },
    });
    expect(await runPrefill(CODE, p)).toBe("There is no form open to fill.");
    expect(p.inject).not.toHaveBeenCalled();
  });

  it("refuses a tab whose URL Chrome didn't give", async () => {
    const p = ports({ activeTab: async () => ({ id: 7 }) });
    expect(await runPrefill(CODE, p)).toBe("There is no form open to fill.");
    expect(p.inject).not.toHaveBeenCalled();
  });

  it("injects the plan into the tab it checked, with that tab's host and path to re-check", async () => {
    const p = ports();
    expect(await runPrefill(CODE, p)).toBe(
      "Filled 4 fields. Check the form, then submit it yourself.",
    );
    expect(p.inject.mock.calls[0]).toEqual([
      7,
      [
        { name: "first_name", value: "Jo" },
        { name: "last_name", value: "Example" },
        { name: "email", value: "jo@example.com" },
        { name: "question_1", value: "Yes" },
      ],
      { hostname: "boards.greenhouse.io", path: "/example/jobs/123" },
    ]);
  });

  it("says nothing was filled when the page moved before the fill ran", async () => {
    const p = ports({ inject: async () => ({ filled: 0, skipped: 4, moved: true as const }) });
    expect(await runPrefill(CODE, p)).toBe(
      "This tab isn't the application's page, so nothing was filled.",
    );
  });

  it("says nothing was filled when Chrome refuses the injection", async () => {
    const p = ports({
      inject: async () => {
        throw new Error("Cannot access contents of the page");
      },
    });
    expect(await runPrefill(CODE, p)).toBe(
      "Chrome didn't let the extension fill this page, so nothing was filled.",
    );
  });
});

describe("fillForm's page check", () => {
  const input = () => ({
    tagName: "INPUT",
    type: "text",
    value: "",
    offsetParent: {},
    dispatchEvent: () => true,
  });
  const page = (href: string, el = input()): FillDocument & { el: typeof el } => ({
    el,
    location: { href },
    querySelectorAll: () => [el],
  });
  const at = fillTarget(APPLY);

  it("fills when the page is still the planned host and path", () => {
    const doc = page(`${APPLY}/?gh_src=x`);
    expect(fillForm([{ name: "first_name", value: "Jo" }], doc, at)).toEqual({
      filled: 1,
      skipped: 0,
    });
    expect(doc.el.value).toBe("Jo");
  });

  it("touches nothing when the page has moved to another path or host", () => {
    const moved = [
      page("https://boards.greenhouse.io/example/jobs/999"),
      page("https://evil.example.com/example/jobs/123"),
      page("http://boards.greenhouse.io/example/jobs/123"),
      page("https://boards.greenhouse.io:8443/example/jobs/123"),
    ];
    expect(moved.map((doc) => fillForm([{ name: "first_name", value: "Jo" }], doc, at))).toEqual([
      { filled: 0, skipped: 1, moved: true },
      { filled: 0, skipped: 1, moved: true },
      { filled: 0, skipped: 1, moved: true },
      { filled: 0, skipped: 1, moved: true },
    ]);
    expect(moved.map((doc) => doc.el.value)).toEqual(["", "", "", ""]);
  });
});
