import { describe, expect, it } from "vitest";
import { ashby } from "../adapters/ashby.js";
import { greenhouse } from "../adapters/greenhouse.js";
import { lever } from "../adapters/lever.js";
import { APPLY_URLS, CONFIRMATIONS, FORMS, RESUME } from "../test/fixtures.js";
import { createPlaywrightDriver, DriverError, onHosts } from "./driver.js";
import { ASHBY_PAGE, doc, el, GREENHOUSE_PAGE, LEVER_PAGE } from "./test/dom.js";
import { fakePage, fakeRoute } from "./test/page.js";

// The Playwright form driver (NS-142) on a scripted page with synthetic forms. No browser.

const URL_GH = APPLY_URLS.greenhouse;
const DONE = CONFIRMATIONS.greenhouse.url;
const confirmation = () => doc([], { text: "Thank you for applying." });

const greenhouseDriver = (over: Parameters<typeof fakePage>[0] = { pages: {} }) => {
  const page = fakePage({
    pages: { [URL_GH]: GREENHOUSE_PAGE, ...over.pages },
    afterSubmit: over.afterSubmit ?? { url: DONE, page: confirmation },
    ...(over.submitButtons === undefined ? {} : { submitButtons: over.submitButtons }),
  });
  return { page, driver: createPlaywrightDriver({ page, hosts: greenhouse.hosts }) };
};

// A URL with a user name and password, built so no address-like text sits in the source.
function withCredentials(url: string): string {
  const u = new URL(url);
  u.username = "a";
  u.password = "b";
  return u.toString();
}

const FORM = "xpath=//form >> nth=1";

describe("open", () => {
  it("returns the page's form and the URL it is on", async () => {
    const { driver } = greenhouseDriver();
    expect(await driver.open(URL_GH)).toEqual({
      kind: "form",
      url: URL_GH,
      fields: FORMS.greenhouse,
    });
  });

  it.each([
    ["another host", "https://evil.example/examplecorp/jobs/4001"],
    ["plain http", "http://boards.greenhouse.io/examplecorp/jobs/4001"],
    ["a port", "https://boards.greenhouse.io:8443/examplecorp/jobs/4001"],
    ["credentials", withCredentials(URL_GH)],
  ])("refuses %s without navigating", async (_name, url) => {
    const { page, driver } = greenhouseDriver();
    await expect(driver.open(url)).rejects.toThrow("the apply URL isn't on the adapter's hosts");
    expect(page.actions).toEqual([]);
  });

  it("returns a challenge for a sign-in wall and never reads it as a form", async () => {
    const wall = () =>
      doc([
        [
          el("input", { name: "email", type: "email" }),
          el("input", { name: "pw", type: "password" }),
        ],
      ]);
    const { driver } = greenhouseDriver({ pages: { [URL_GH]: wall } });
    expect(await driver.open(URL_GH)).toEqual({ kind: "challenge", challenge: "login" });
  });

  it("refuses a page a server redirect moved off the hosts", async () => {
    const away = "https://careers.example/jobs/4001";
    const page = fakePage({ pages: { [away]: GREENHOUSE_PAGE }, redirects: { [URL_GH]: away } });
    const driver = createPlaywrightDriver({ page, hosts: greenhouse.hosts });
    await expect(driver.open(URL_GH)).rejects.toThrow(
      new DriverError("the page left the adapter's hosts"),
    );
    expect(page.actions.some((a) => a.action === "evaluate")).toBe(false);
  });

  it("gives every browser action the step's time limit", () => {
    const page = fakePage({ pages: {} });
    createPlaywrightDriver({ page, hosts: greenhouse.hosts, stepTimeoutMs: 12_000 });
    expect(page.defaultTimeout()).toBe(12_000);
  });

  it("returns a page with no form as proof material", async () => {
    const { driver } = greenhouseDriver({ pages: { [URL_GH]: () => doc([], { text: "Closed" }) } });
    expect(await driver.open(URL_GH)).toEqual({
      kind: "page",
      url: URL_GH,
      html: `<html><body>synthetic page at ${URL_GH}</body></html>`,
      screenshotPng: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });
  });
});

describe("keeping the page on the adapter's hosts", () => {
  it("aborts a main-frame navigation off the hosts and lets the rest through", async () => {
    const { page, driver } = greenhouseDriver();
    await driver.open(URL_GH);
    const handler = page.routeHandler();
    const offHost = fakeRoute("https://evil.example/phish", true);
    const onHost = fakeRoute(DONE, true);
    const script = fakeRoute("https://cdn.example/app.js", false);
    const frame = fakeRoute("https://evil.example/widget", true, { frame: "child" });
    for (const r of [offHost, onHost, script, frame]) await handler?.(r.route);
    expect([offHost.result, onHost.result, script.result, frame.result]).toEqual([
      { aborted: "blockedbyclient", fellBack: false },
      { aborted: null, fellBack: true },
      { aborted: null, fellBack: true },
      { aborted: null, fellBack: true },
    ]);
  });

  it("closes a popup the page opens", async () => {
    const { page, driver } = greenhouseDriver();
    await driver.open(URL_GH);
    page.firePopup();
    await Promise.resolve();
    expect(page.popups).toEqual([{ closed: true }]);
  });

  it("checks a URL the same way the gateway does", () => {
    expect([
      onHosts(greenhouse.hosts, "https://job-boards.greenhouse.io/x/jobs/1"),
      onHosts(greenhouse.hosts, "https://boards.greenhouse.io.evil.example/x"),
      onHosts(greenhouse.hosts, "not a url"),
    ]).toEqual([true, false, false]);
  });
});

describe("fillAndSubmit", () => {
  it("fills each field, uploads the files, presses the one submit button and returns the next page", async () => {
    const { page, driver } = greenhouseDriver();
    await driver.open(URL_GH);
    page.actions.length = 0;
    const after = await driver.fillAndSubmit(
      [
        { field: "first_name", value: "Ada" },
        { field: "email", value: "ada@example.com" },
        { field: "question_1001", value: "Yes" },
        { field: "question_1002", value: "Synthetic answer for a test." },
      ],
      [{ field: "resume", fileName: "ada-lovelace-resume.pdf", bytes: RESUME }],
    );
    expect(page.actions).toEqual([
      { action: "count", selector: "xpath=//form" },
      { action: "fill", selector: `${FORM} >> [name="first_name"]`, value: "Ada" },
      { action: "fill", selector: `${FORM} >> [name="email"]`, value: "ada@example.com" },
      {
        action: "selectOption",
        selector: `${FORM} >> [name="question_1001"]`,
        value: [{ label: "Yes" }],
      },
      {
        action: "fill",
        selector: `${FORM} >> [name="question_1002"]`,
        value: "Synthetic answer for a test.",
      },
      {
        action: "setInputFiles",
        selector: `${FORM} >> [name="resume"]`,
        value: [
          { name: "ada-lovelace-resume.pdf", mimeType: "application/pdf", bytes: RESUME.length },
        ],
      },
      {
        action: "count",
        selector: `${FORM} >> button[type="submit"], input[type="submit"], button:not([type])`,
      },
      {
        action: "click",
        selector: `${FORM} >> button[type="submit"], input[type="submit"], button:not([type])`,
      },
      { action: "waitForLoadState", value: "networkidle" },
      { action: "evaluate", value: "collectPage" },
      { action: "content" },
      { action: "screenshot" },
    ]);
    expect(after).toMatchObject({ kind: "page", url: DONE });
  });

  it("checks a radio and a checkbox group by label in the page", async () => {
    const leverUrl = APPLY_URLS.lever;
    const page = fakePage({
      pages: { [leverUrl]: LEVER_PAGE },
      afterSubmit: { url: leverUrl, page: confirmation },
    });
    const driver = createPlaywrightDriver({ page, hosts: lever.hosts });
    await driver.open(leverUrl);
    await driver.fillAndSubmit([{ field: "cards[aaaa][field0]", value: "Yes" }], []);
    expect(page.actions.filter((a) => a.action === "evaluate").map((a) => a.value)).toEqual([
      "collectPage",
      "chooseOptions",
      "collectPage",
    ]);
  });

  it("refuses a checkbox option the page has lost since it was read", async () => {
    const ashbyUrl = APPLY_URLS.ashby;
    const shared = ASHBY_PAGE();
    const page = fakePage({ pages: { [ashbyUrl]: () => shared } });
    const driver = createPlaywrightDriver({ page, hosts: ashby.hosts });
    await driver.open(ashbyUrl);
    // The page's script drops the "Remote" checkbox after the driver read the form.
    (shared.forms[0]?.elements as unknown[] | undefined)?.splice(4, 1);
    await expect(
      driver.fillAndSubmit(
        [{ field: "5f0c1e2a-0000-4000-8000-000000000001", value: ["Remote"] }],
        [],
      ),
    ).rejects.toThrow("5f0c1e2a-0000-4000-8000-000000000001 lost an option");
    expect(page.actions.some((a) => a.action === "click")).toBe(false);
  });

  it.each([
    [
      "a field the form doesn't have",
      [{ field: "salary", value: "1" }],
      "the form has no field salary",
    ],
    [
      "a value outside a select's options",
      [{ field: "question_1001", value: "Maybe" }],
      "isn't one of its options",
    ],
    [
      "two values for a text field",
      [{ field: "first_name", value: ["A", "B"] }],
      "first_name takes one value",
    ],
    ["the hidden token", [{ field: "authenticity_token", value: "x" }], "is a hidden field"],
    ["a file as text", [{ field: "resume", value: "x" }], "is a file field"],
  ])("refuses %s before pressing anything", async (_name, fills, message) => {
    const { page, driver } = greenhouseDriver();
    await driver.open(URL_GH);
    await expect(driver.fillAndSubmit(fills, [])).rejects.toThrow(message);
    expect(page.actions.some((a) => a.action === "click")).toBe(false);
  });

  it("refuses an upload to a field that isn't a file input", async () => {
    const { driver } = greenhouseDriver();
    await driver.open(URL_GH);
    await expect(
      driver.fillAndSubmit([], [{ field: "first_name", fileName: "r.pdf", bytes: RESUME }]),
    ).rejects.toThrow("the form has no file field first_name");
  });

  it.each([0, 2])("refuses to guess when the form has %i submit buttons", async (submitButtons) => {
    const { page, driver } = greenhouseDriver({ pages: {}, submitButtons });
    await driver.open(URL_GH);
    await expect(driver.fillAndSubmit([], [])).rejects.toThrow(
      `the form has ${submitButtons} submit buttons, not one`,
    );
    expect(page.actions.some((a) => a.action === "click")).toBe(false);
  });

  it("refuses to type anything when the page's forms changed since they were read", async () => {
    const shared = GREENHOUSE_PAGE();
    const page = fakePage({ pages: { [URL_GH]: () => shared } });
    const driver = createPlaywrightDriver({ page, hosts: greenhouse.hosts });
    await driver.open(URL_GH);
    // A widget's form appears ahead of the application form, which would shift its index.
    (shared.forms as unknown[]).unshift({ elements: [] });
    await expect(driver.fillAndSubmit([{ field: "first_name", value: "Ada" }], [])).rejects.toThrow(
      "the page now has 3 forms, not 2",
    );
    expect(page.actions.some((a) => a.action === "fill")).toBe(false);
  });

  it("still returns the page after submit when it never goes quiet", async () => {
    const { page, driver } = greenhouseDriver();
    await driver.open(URL_GH);
    page.before.set("waitForLoadState", () => {
      throw Object.assign(new Error("Timeout 60000ms exceeded."), { name: "TimeoutError" });
    });
    expect(await driver.fillAndSubmit([], [])).toMatchObject({ kind: "page", url: DONE });
  });

  it("refuses to submit when no form was opened", async () => {
    const { driver } = greenhouseDriver();
    await expect(driver.fillAndSubmit([], [])).rejects.toThrow("no form is open");
  });

  it("returns a challenge that appears after submit", async () => {
    const { driver } = greenhouseDriver({
      pages: {},
      afterSubmit: {
        url: DONE,
        page: () => doc([], { others: [el("div", { class: "h-captcha" })] }),
      },
    });
    await driver.open(URL_GH);
    expect(await driver.fillAndSubmit([], [])).toEqual({ kind: "challenge", challenge: "captcha" });
  });

  it("never reads the page after submit as a form to fill again", async () => {
    const { driver } = greenhouseDriver({
      pages: {},
      afterSubmit: { url: URL_GH, page: GREENHOUSE_PAGE },
    });
    await driver.open(URL_GH);
    expect(await driver.fillAndSubmit([], [])).toMatchObject({ kind: "page", url: URL_GH });
    await expect(driver.fillAndSubmit([], [])).rejects.toThrow("no form is open");
  });
});

describe("close", () => {
  it("stops a submit in flight before it presses the button", async () => {
    // The page stays open after close, so only the driver's own check can stop the click.
    const page = fakePage({ pages: { [URL_GH]: GREENHOUSE_PAGE } });
    const driver = createPlaywrightDriver({
      page,
      hosts: greenhouse.hosts,
      onClose: async () => {},
    });
    await driver.open(URL_GH);
    // The gateway's time limit fires while the driver is counting submit buttons.
    page.before.set("count", async () => {
      if (page.actions.filter((a) => a.action === "count").length === 1) await driver.close();
    });
    await expect(driver.fillAndSubmit([], [])).rejects.toThrow(
      new DriverError("the driver was closed"),
    );
    expect([page.actions.some((a) => a.action === "click"), page.closed()]).toEqual([false, false]);
  });

  it("refuses every step after close, and closing twice closes once", async () => {
    const { page, driver } = greenhouseDriver();
    await driver.close();
    await driver.close();
    await expect(driver.open(URL_GH)).rejects.toThrow(new DriverError("the driver was closed"));
    expect(page.actions).toEqual([{ action: "close" }]);
  });

  it("runs the given close instead of the page's", async () => {
    const page = fakePage({ pages: {} });
    let ended = 0;
    const driver = createPlaywrightDriver({
      page,
      hosts: greenhouse.hosts,
      onClose: async () => {
        ended++;
      },
    });
    await driver.close();
    expect([ended, page.closed()]).toEqual([1, false]);
  });

  it("refuses to start without hosts", () => {
    expect(() => createPlaywrightDriver({ page: fakePage({ pages: {} }), hosts: [] })).toThrow(
      "the driver needs the adapter's hosts",
    );
  });
});
