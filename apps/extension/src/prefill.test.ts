import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Fill,
  type FillDocument,
  type FillElement,
  filledMessage,
  fillForm,
  PACKAGE_TIMEOUT_MS,
  type PrefillPackage,
  packageRequest,
  prefillMessage,
  prefillPlan,
} from "./prefill.js";

// The pre-fill's plain logic (NS-192 slice 3) on synthetic packages and fake page elements: no
// browser, no real form. Invented names and example.com only.

const PKG: PrefillPackage = {
  handoffId: "0b6f3f8e-6a55-4c7e-9a52-5d6b2f8a1c01",
  applicationId: "5c1e2a7d-3b4f-4e8a-9c6d-7f0a1b2c3d4e",
  ats: "greenhouse",
  applyUrl: "https://boards.greenhouse.io/example/jobs/123",
  contact: { firstName: "Jo", lastName: "Example", email: "jo@example.com", phone: null },
  fields: { question_1: "Yes", question_2: ["Remote", "Hybrid"] },
};

describe("prefillPlan", () => {
  it("fills the adapter's contact fields, then the package's own fields, on the apply page", () => {
    expect(prefillPlan(PKG, "https://boards.greenhouse.io/example/jobs/123/")).toEqual({
      ok: true,
      fills: [
        { name: "first_name", value: "Jo" },
        { name: "last_name", value: "Example" },
        { name: "email", value: "jo@example.com" },
        { name: "question_1", value: "Yes" },
        { name: "question_2", value: ["Remote", "Hybrid"] },
      ],
    });
  });

  it("adds the phone field only when there is a phone", () => {
    const pkg = { ...PKG, contact: { ...PKG.contact, phone: "+1 555 0100" } };
    const plan = prefillPlan(pkg, PKG.applyUrl);
    expect(plan.ok && plan.fills.find((f) => f.name === "phone")).toEqual({
      name: "phone",
      value: "+1 555 0100",
    });
  });

  it("uses each ATS's own contact field names", () => {
    const lever = prefillPlan(
      { ...PKG, ats: "lever", applyUrl: "https://jobs.lever.co/example/abc/apply", fields: {} },
      "https://jobs.lever.co/example/abc/apply",
    );
    expect(lever).toEqual({
      ok: true,
      fills: [
        { name: "name", value: "Jo Example" },
        { name: "email", value: "jo@example.com" },
      ],
    });
  });

  it.each([
    ["an http tab", "http://boards.greenhouse.io/example/jobs/123", "not_https"],
    ["a tab with a port", "https://boards.greenhouse.io:8443/example/jobs/123", "not_https"],
    ["a tab with credentials", "https://u:p@boards.greenhouse.io/example/jobs/123", "not_https"],
    ["another site", "https://jobs.example.com/example/jobs/123", "wrong_host"],
    ["a lookalike host", "https://boards.greenhouse.io.example.com/example/jobs/123", "wrong_host"],
    ["another page on the ATS", "https://boards.greenhouse.io/example/jobs/999", "wrong_page"],
    ["the ATS's other host", "https://job-boards.greenhouse.io/example/jobs/123", "wrong_page"],
  ])("fills nothing on %s", (_case, tabUrl, refusal) => {
    expect(prefillPlan(PKG, tabUrl)).toEqual({ ok: false, refusal });
  });

  it("refuses a package field that would take over a contact or file field", () => {
    expect(prefillPlan({ ...PKG, fields: { email: "x@example.com" } }, PKG.applyUrl)).toEqual({
      ok: false,
      refusal: "form_changed",
    });
    expect(prefillPlan({ ...PKG, fields: { resume: "x" } }, PKG.applyUrl)).toEqual({
      ok: false,
      refusal: "form_changed",
    });
    expect(prefillPlan({ ...PKG, fields: { "question\n1": "x" } }, PKG.applyUrl)).toEqual({
      ok: false,
      refusal: "form_changed",
    });
  });
});

// A fake element that records the events fired on it.
function el(over: Partial<FillElement> & { tagName: string }): FillElement & { events: string[] } {
  const events: string[] = [];
  return {
    value: "",
    events,
    dispatchEvent: (e: Event) => {
      events.push(e.type);
      return true;
    },
    ...over,
  };
}

// A fake document: elements by their name, and every selector asked for.
function page(byName: Record<string, FillElement[]>) {
  const asked: string[] = [];
  const doc: FillDocument = {
    querySelectorAll: (selector) => {
      asked.push(selector);
      const name = /^\[name="(.*)"\]$/.exec(selector)?.[1]?.replace(/\\(.)/g, "$1") ?? "";
      return byName[name] ?? [];
    },
  };
  return { doc, asked };
}

describe("fillForm", () => {
  it("sets text and textarea values and fires input and change", () => {
    const first = el({ tagName: "INPUT", type: "text" });
    const note = el({ tagName: "TEXTAREA" });
    const { doc } = page({ first_name: [first], note: [note] });
    const result = fillForm(
      [
        { name: "first_name", value: "Jo" },
        { name: "note", value: "Hello" },
      ],
      doc,
    );
    expect([result, first.value, note.value, first.events]).toEqual([
      { filled: 2, skipped: 0 },
      "Jo",
      "Hello",
      ["input", "change"],
    ]);
  });

  it.each([
    ["a file input", { tagName: "INPUT", type: "file" }],
    ["a hidden input", { tagName: "INPUT", type: "hidden" }],
    ["a submit button", { tagName: "INPUT", type: "submit" }],
    ["a button", { tagName: "BUTTON" }],
    ["a disabled input", { tagName: "INPUT", type: "text", disabled: true }],
    ["an input hidden by the page", { tagName: "INPUT", type: "text", hidden: true }],
    ["an input that isn't laid out", { tagName: "INPUT", type: "text", offsetParent: null }],
  ])("skips %s and fires nothing on it", (_case, over) => {
    const target = el(over);
    const { doc } = page({ x: [target] });
    expect([fillForm([{ name: "x", value: "v" }], doc), target.value, target.events]).toEqual([
      { filled: 0, skipped: 1 },
      "",
      [],
    ]);
  });

  it("skips a field the page doesn't have", () => {
    const { doc } = page({});
    expect(fillForm([{ name: "question_9", value: "Yes" }], doc)).toEqual({
      filled: 0,
      skipped: 1,
    });
  });

  it("picks a select's option by value or label, and skips a value it doesn't offer", () => {
    const options = [
      { value: "1", text: "Yes", selected: false },
      { value: "0", text: "No", selected: false },
    ];
    const select = el({ tagName: "SELECT", options });
    const { doc } = page({ q: [select] });
    expect(fillForm([{ name: "q", value: "Yes" }], doc)).toEqual({ filled: 1, skipped: 0 });
    expect(options.map((o) => o.selected)).toEqual([true, false]);
    expect(fillForm([{ name: "q", value: "Maybe" }], doc)).toEqual({ filled: 0, skipped: 1 });
    expect(options.map((o) => o.selected)).toEqual([true, false]);
  });

  it("puts several values only on a multiple select", () => {
    const options = [
      { value: "Remote", text: "Remote", selected: false },
      { value: "Hybrid", text: "Hybrid", selected: false },
    ];
    const single = el({ tagName: "SELECT", options });
    const { doc } = page({ q: [single] });
    const fills: Fill[] = [{ name: "q", value: ["Remote", "Hybrid"] }];
    expect(fillForm(fills, doc)).toEqual({ filled: 0, skipped: 1 });
    const multi = el({ tagName: "SELECT", options, multiple: true });
    expect(fillForm(fills, page({ q: [multi] }).doc)).toEqual({ filled: 1, skipped: 0 });
    expect(options.map((o) => o.selected)).toEqual([true, true]);
  });

  it("checks only the checkboxes whose value is chosen", () => {
    const remote = el({ tagName: "INPUT", type: "checkbox", value: "Remote", checked: false });
    const onsite = el({ tagName: "INPUT", type: "checkbox", value: "Onsite", checked: true });
    const { doc } = page({ where: [remote, onsite] });
    fillForm([{ name: "where", value: ["Remote"] }], doc);
    expect([remote.checked, onsite.checked]).toEqual([true, false]);
  });

  it("leaves a radio group untouched and counts it skipped when no option carries the value", () => {
    const yes = el({ tagName: "INPUT", type: "radio", value: "Yes", checked: true });
    const no = el({ tagName: "INPUT", type: "radio", value: "No", checked: false });
    const { doc } = page({ q: [yes, no] });
    expect([fillForm([{ name: "q", value: "Maybe" }], doc), yes.checked, no.checked]).toEqual([
      { filled: 0, skipped: 1 },
      true,
      false,
    ]);
  });

  it("asks for each field by its exact name, with quotes escaped", () => {
    const { doc, asked } = page({});
    fillForm([{ name: 'cards[0]["a"]', value: "v" }], doc);
    expect(asked).toEqual(['[name="cards[0][\\"a\\"]"]']);
  });

  it("never clicks or submits: it only sets values and fires input and change", () => {
    const click = vi.fn();
    const submit = vi.fn();
    const input = { ...el({ tagName: "INPUT", type: "text" }), click, submit };
    fillForm([{ name: "x", value: "v" }], page({ x: [input] }).doc);
    expect([click.mock.calls.length, submit.mock.calls.length, input.events]).toEqual([
      0,
      0,
      ["input", "change"],
    ]);
  });
});

describe("packageRequest", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the handoff id and grant with the extension's own token, nothing else", () => {
    const { url, init } = packageRequest(
      { apiOrigin: "http://127.0.0.1:8787", token: "test-token" },
      PKG.handoffId,
      "g".repeat(43),
    );
    expect([url, init.method, init.headers, init.body]).toEqual([
      "http://127.0.0.1:8787/handoffs/package",
      "POST",
      { "content-type": "application/json", authorization: "Bearer test-token" },
      JSON.stringify({ handoffId: PKG.handoffId, grant: "g".repeat(43) }),
    ]);
  });

  it("gives up after 30 seconds", () => {
    vi.useFakeTimers();
    const { init } = packageRequest(
      { apiOrigin: "http://127.0.0.1:8787", token: "test-token" },
      PKG.handoffId,
      "g".repeat(43),
    );
    vi.advanceTimersByTime(PACKAGE_TIMEOUT_MS - 1);
    expect(init.signal?.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(init.signal?.aborted).toBe(true);
  });
});

describe("pre-fill messages", () => {
  it("says what happened in plain words, and never claims a submit", () => {
    expect(prefillMessage("grant_invalid")).toBe(
      "That pre-fill link has expired or was already used. Start again from Northstar.",
    );
    expect(prefillMessage("something_new")).toBe("Northstar couldn't pre-fill this form.");
    expect(filledMessage({ filled: 4, skipped: 1 })).toBe(
      "Filled 4 fields. 1 couldn't be filled. Check the form, then submit it yourself.",
    );
  });
});
