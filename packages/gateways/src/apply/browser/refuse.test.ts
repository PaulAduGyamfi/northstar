import { describe, expect, it } from "vitest";
import { greenhouse } from "../adapters/greenhouse.js";
import { lever } from "../adapters/lever.js";
import { RECORDED, recordedPage } from "../test/recorded.js";
import { collectPage, type FormFacts, formProblem } from "./collect.js";
import { createPlaywrightDriver, DriverError } from "./driver.js";
import { doc, el } from "./test/dom.js";
import { fakePage } from "./test/page.js";

// NS-255 (#353): the driver refuses form shapes the recorded Greenhouse and Lever pages showed it
// can't fill or submit safely. Refuse, never handle: such a form opens as no form, so the gateway
// hands off (form_changed) before anything is typed or pressed. Synthetic pages and the committed
// recordings only; nothing is fetched.

const URL_GH = "https://job-boards.greenhouse.io/examplecorp/jobs/4001";
const URL_LV = "https://jobs.lever.co/examplecorp/0a0a0a0a-0000-4000-8000-000000000002/apply";

const facts = (page: ReturnType<typeof doc>): FormFacts | undefined =>
  collectPage(null, page).facts[0];

// A named, otherwise fillable form with one more control or button.
const form = (...extra: ReturnType<typeof el>[]) =>
  doc([
    [
      el("input", { name: "first_name", type: "text", required: "" }),
      el("input", { name: "email", type: "email", required: "" }),
      ...extra,
    ],
  ]);
const SUBMIT = el("button", { type: "submit" });

describe("formProblem", () => {
  it.each([
    [
      { unnamedFields: 1, comboboxes: 0, submits: [{ hidden: false, captcha: false }] },
      "unnamed_fields",
    ],
    [{ unnamedFields: 0, comboboxes: 1, submits: [{ hidden: false, captcha: false }] }, "combobox"],
    [{ unnamedFields: 0, comboboxes: 0, submits: [] }, "no_submit"],
    [
      {
        unnamedFields: 0,
        comboboxes: 0,
        submits: [
          { hidden: false, captcha: false },
          { hidden: false, captcha: false },
        ],
      },
      "several_submits",
    ],
    [
      { unnamedFields: 0, comboboxes: 0, submits: [{ hidden: true, captcha: false }] },
      "hidden_submit",
    ],
    [
      { unnamedFields: 0, comboboxes: 0, submits: [{ hidden: false, captcha: true }] },
      "captcha_submit",
    ],
    [{ unnamedFields: 0, comboboxes: 0, submits: [{ hidden: false, captcha: false }] }, null],
  ] as const)("gives %j the problem %s", (f, problem) => {
    expect(formProblem({ ...f, submits: [...f.submits] })).toBe(problem);
  });
});

describe("the facts the in-page reader reports", () => {
  it("counts the recorded Greenhouse form's name-less fields and comboboxes", () => {
    const f = facts(recordedPage(RECORDED.greenhouse));
    expect([f?.unnamedFields, f?.comboboxes, f && formProblem(f)]).toEqual([
      13,
      5,
      "unnamed_fields",
    ]);
  });

  it("marks the recorded Lever form's only submit as hidden and tied to hCaptcha", () => {
    expect(facts(recordedPage(RECORDED.lever))?.submits).toEqual([{ hidden: true, captcha: true }]);
  });

  it("finds a combobox in a form whose fields all have names", () => {
    const f = facts(form(el("input", { name: "country", role: "combobox" }), SUBMIT));
    expect(f && formProblem(f)).toBe("combobox");
  });

  it("finds no submit in a form whose only button is type=button", () => {
    const f = facts(form(el("button", { type: "button" })));
    expect(f && formProblem(f)).toBe("no_submit");
  });

  it.each([
    ["the hidden attribute", { hidden: "" }],
    ["aria-hidden", { "aria-hidden": "true" }],
    ["a hiding class", { class: "btn sr-only" }],
    ["an inline style", { style: "display: none" }],
  ])("counts a submit hidden by %s as hidden", (_, attrs) => {
    const f = facts(form(el("button", { type: "submit", ...attrs })));
    expect(f && formProblem(f)).toBe("hidden_submit");
  });

  it.each([
    ["its id", { id: "hcaptchaSubmitBtn" }],
    ["its class", { class: "g-recaptcha" }],
    ["its callback", { "data-callback": "onCaptchaDone" }],
    ["a site key", { "data-sitekey": "synthetic-site-key" }],
  ])("ties a submit to a CAPTCHA by %s", (_, attrs) => {
    const f = facts(form(el("button", { type: "submit", ...attrs })));
    expect(f && formProblem(f)).toBe("captcha_submit");
  });

  it("leaves a plain named form with one visible submit alone", () => {
    const f = facts(form(el("input", { name: "token", type: "hidden" }), SUBMIT));
    expect(f && formProblem(f)).toBeNull();
  });

  it("counts an hCaptcha widget marked invisible as a CAPTCHA", () => {
    const page = doc([], { others: [el("div", { class: "h-captcha", "data-size": "invisible" })] });
    expect(collectPage(null, page).signals.visibleCaptcha).toBe(true);
  });
});

describe("open refuses a form it can't fill or submit safely", () => {
  it("opens the recorded Greenhouse form as no form, so nothing can be typed", async () => {
    const page = fakePage({ pages: { [URL_GH]: () => recordedPage(RECORDED.greenhouse) } });
    const driver = createPlaywrightDriver({ page, hosts: greenhouse.hosts });
    const opened = await driver.open(URL_GH);
    await expect(driver.fillAndSubmit([{ field: "first_name", value: "Ada" }], [])).rejects.toThrow(
      new DriverError("no form is open"),
    );
    expect([opened.kind, page.actions.filter((a) => a.action === "fill")]).toEqual(["page", []]);
  });

  it("opens a Lever-shaped form whose only submit is a hidden hCaptcha button as no form", async () => {
    // The recorded Lever form without its hCaptcha widget: the submit button alone must refuse.
    const noWidget = { ...RECORDED.lever, captcha: [] };
    const page = fakePage({ pages: { [URL_LV]: () => recordedPage(noWidget) } });
    const driver = createPlaywrightDriver({ page, hosts: lever.hosts });
    const opened = await driver.open(URL_LV);
    expect([opened.kind, page.actions.some((a) => a.action === "click")]).toEqual(["page", false]);
  });

  it("opens the recorded Lever form as a CAPTCHA challenge", async () => {
    const page = fakePage({ pages: { [URL_LV]: () => recordedPage(RECORDED.lever) } });
    const driver = createPlaywrightDriver({ page, hosts: lever.hosts });
    expect(await driver.open(URL_LV)).toEqual({ kind: "challenge", challenge: "captcha" });
  });
});
