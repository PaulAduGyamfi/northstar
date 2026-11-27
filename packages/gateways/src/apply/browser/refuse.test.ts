import { AsyncLocalStorage } from "node:async_hooks";
import { type Context, type ContextManager, context, ROOT_CONTEXT } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { greenhouse } from "../adapters/greenhouse.js";
import { lever } from "../adapters/lever.js";
import { RECORDED, recordedPage } from "../test/recorded.js";
import { collectPage, type FormFacts, formProblem } from "./collect.js";
import { createPlaywrightDriver, DriverError } from "./driver.js";
import { doc, el, type FakeElement } from "./test/dom.js";
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

describe("refusals the driver must see in a named form", () => {
  it("opens a named form with a combobox as no form, and types nothing", async () => {
    const url = URL_GH;
    const page = fakePage({
      pages: { [url]: () => form(el("input", { name: "country", role: "combobox" }), SUBMIT) },
    });
    const driver = createPlaywrightDriver({ page, hosts: greenhouse.hosts });
    const opened = await driver.open(url);
    expect([opened.kind, page.actions.filter((a) => a.action === "fill")]).toEqual(["page", []]);
  });

  it("judges the buttons inside the form, as the click locator does, not the form's elements list", () => {
    // A hostile page: a clean submit outside the form joined to it by form="…", and inside it a
    // CAPTCHA-tied submit that belongs to another form. The click locator would find the inside one.
    const fields: FakeElement[] = [el("input", { name: "email", type: "email" })];
    const outside = el("button", { type: "submit", form: "apply" });
    const inside = el("button", { type: "submit", form: "other", id: "captchaGo" });
    const hostile = {
      ...doc([]),
      forms: [
        {
          elements: [...fields, outside],
          getElementsByTagName: (name: string) =>
            [...fields, inside].filter((e) => e.tagName === name.toUpperCase()),
        },
      ],
    };
    const f = collectPage(null, hostile).facts[0];
    expect(f && formProblem(f)).toBe("captcha_submit");
  });
});

// A context manager over Node's AsyncLocalStorage, so the span stays active across the driver's
// awaits (the package has no OpenTelemetry context manager of its own).
class StoreContextManager implements ContextManager {
  private store = new AsyncLocalStorage<Context>();
  active(): Context {
    return this.store.getStore() ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.store.run(ctx, () => fn.call(thisArg, ...args));
  }
  bind<T>(_ctx: Context, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    return this;
  }
}

describe("the refusal on the span", () => {
  it("puts the problem code, and nothing from the page, on the active span", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    context.setGlobalContextManager(new StoreContextManager());
    try {
      // The recorded Greenhouse form with its ids as names, so a form is picked; its stand-in
      // required input still has no name, so it is refused as unnamed_fields.
      const named = {
        ...RECORDED.greenhouse,
        controls: RECORDED.greenhouse.controls.map((c) =>
          c.id === undefined ? c : { ...c, name: c.id },
        ),
      };
      const namedPage = fakePage({ pages: { [URL_GH]: () => recordedPage(named) } });
      const tracer = provider.getTracer("test");
      await tracer.startActiveSpan("apply.submit", async (span) => {
        await createPlaywrightDriver({ page: namedPage, hosts: greenhouse.hosts }).open(URL_GH);
        span.end();
      });
      const [span] = exporter.getFinishedSpans();
      expect(span?.attributes).toEqual({ "northstar.apply.form_problem": "unnamed_fields" });
    } finally {
      context.disable();
    }
  });
});

describe("fillAndSubmit re-reads the form just before submit (NS-256)", () => {
  // A form that opens clean; each test changes it after open, as a page's own script could.
  const changing = () => {
    const submit = el("button", { type: "submit" });
    // The stand-in DOM holds this array itself, so pushing to it changes the open form.
    const controls: FakeElement[] = [
      el("input", { name: "first_name", type: "text", required: "" }),
      el("input", { name: "email", type: "email", required: "" }),
      submit,
    ];
    const page = doc([controls]);
    const fake = fakePage({ pages: { [URL_GH]: () => page } });
    const driver = createPlaywrightDriver({ page: fake, hosts: greenhouse.hosts });
    return { page, controls, submit, fake, driver };
  };
  const clicked = (fake: ReturnType<typeof fakePage>) =>
    fake.actions.some((a) => a.action === "click");

  it("refuses a form that gained a combobox after open, and presses nothing", async () => {
    const { controls, fake, driver } = changing();
    expect((await driver.open(URL_GH)).kind).toBe("form");
    controls.push(el("input", { name: "country", role: "combobox" }));
    await expect(
      driver.fillAndSubmit([{ field: "email", value: "ada@example.com" }], []),
    ).rejects.toThrow(new DriverError("the form changed before submit: combobox"));
    expect(clicked(fake)).toBe(false);
  });

  it("refuses a submit that became tied to a CAPTCHA after open, and presses nothing", async () => {
    const { submit, fake, driver } = changing();
    await driver.open(URL_GH);
    submit.attrs["data-callback"] = "onCaptchaDone";
    await expect(driver.fillAndSubmit([], [])).rejects.toThrow(
      new DriverError("the form changed before submit: captcha_submit"),
    );
    expect(clicked(fake)).toBe(false);
  });

  it("refuses when a CAPTCHA appears after open, and presses nothing", async () => {
    const { page, fake, driver } = changing();
    await driver.open(URL_GH);
    const before = Array.from(page.getElementsByTagName("*"));
    page.getElementsByTagName = () => [...before, el("div", { class: "h-captcha" })];
    await expect(driver.fillAndSubmit([], [])).rejects.toThrow(
      new DriverError("a challenge appeared before submit"),
    );
    expect(clicked(fake)).toBe(false);
  });
});
