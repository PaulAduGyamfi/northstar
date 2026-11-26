import { describe, expect, it } from "vitest";
import { FORMS } from "../test/fixtures.js";
import {
  type ChallengeSignals,
  COLLECT_LIMITS,
  challengeOf,
  checkCollected,
  chooseOptions,
  collectPage,
  pickForm,
  toFields,
} from "./collect.js";
import { ASHBY_PAGE, doc, el, GREENHOUSE_PAGE, LEVER_PAGE } from "./test/dom.js";

// Reading an application page (NS-142) on synthetic pages in a stand-in DOM.

describe("reading a form", () => {
  it.each([
    ["greenhouse", GREENHOUSE_PAGE, 1],
    ["lever", LEVER_PAGE, 0],
    ["ashby", ASHBY_PAGE, 0],
  ] as const)(
    "reads the synthetic %s form into the fields the adapter expects",
    (ats, page, index) => {
      const picked = pickForm(collectPage(null, page()).forms);
      expect(picked).toEqual({ index, fields: FORMS[ats] });
    },
  );

  it("reads url, number, date and search inputs as text and leaves out buttons and passwords", () => {
    const fields = toFields([
      { tag: "input", type: "url", name: "site", required: false, options: [] },
      { tag: "input", type: "number", name: "years", required: true, options: [] },
      { tag: "input", type: "date", name: "start", required: false, options: [] },
      { tag: "input", type: "search", name: "q", required: false, options: [] },
      { tag: "input", type: "submit", name: "go", required: false, options: [] },
      { tag: "button", type: "submit", name: "send", required: false, options: [] },
      { tag: "input", type: "password", name: "pw", required: false, options: [] },
    ]);
    expect(fields).toEqual([
      { name: "site", type: "text", required: false },
      { name: "years", type: "text", required: true },
      { name: "start", type: "text", required: false },
      { name: "q", type: "text", required: false },
    ]);
  });

  it("makes a radio group required when any of its inputs is", () => {
    const fields = toFields([
      { tag: "input", type: "radio", name: "r", required: false, options: ["A"] },
      { tag: "input", type: "radio", name: "r", required: true, options: ["B"] },
    ]);
    expect(fields).toEqual([{ name: "r", type: "radio", required: true, options: ["A", "B"] }]);
  });

  it("finds no form on a page without one", () => {
    expect(pickForm(collectPage(null, doc([])).forms)).toBe(null);
  });

  it("uses a radio's value when it has no label", () => {
    const page = doc([[el("input", { name: "r", type: "radio", value: "Yes" })]]);
    expect(collectPage(null, page).forms[0]?.[0]?.options).toEqual(["Yes"]);
  });
});

describe("challengeOf", () => {
  const none: ChallengeSignals = {
    visibleCaptcha: false,
    cloudflareInterstitial: false,
    passwordFields: 0,
    oneTimeCode: false,
    signUpWords: false,
  };

  it.each([
    ["a visible captcha", { visibleCaptcha: true }, "captcha"],
    ["Cloudflare's interstitial", { cloudflareInterstitial: true }, "captcha"],
    ["a one-time code field", { oneTimeCode: true }, "mfa"],
    ["two password fields", { passwordFields: 2 }, "account"],
    ["a password field with sign-up words", { passwordFields: 1, signUpWords: true }, "account"],
    ["one password field", { passwordFields: 1 }, "login"],
    ["sign-up words alone", { signUpWords: true }, null],
    ["nothing", {}, null],
  ] as const)("reads %s as %s", (_name, signals, expected) => {
    expect(challengeOf({ ...none, ...signals })).toBe(expected);
  });
});

describe("challenge signals from the page", () => {
  const signals = (page: ReturnType<typeof doc>) => collectPage(null, page).signals;

  it("counts a visible reCAPTCHA widget but not an invisible one", () => {
    const visible = doc([], { others: [el("div", { class: "form g-recaptcha" })] });
    const invisible = doc([], {
      others: [el("div", { class: "g-recaptcha", "data-size": "invisible" })],
    });
    expect([signals(visible).visibleCaptcha, signals(invisible).visibleCaptcha]).toEqual([
      true,
      false,
    ]);
  });

  it("counts hCaptcha, Turnstile and Cloudflare's interstitial", () => {
    expect([
      signals(doc([], { others: [el("div", { class: "h-captcha" })] })).visibleCaptcha,
      signals(doc([], { others: [el("div", { class: "cf-turnstile" })] })).visibleCaptcha,
      signals(doc([], { title: "Just a moment..." })).cloudflareInterstitial,
      signals(doc([], { others: [el("form", { id: "challenge-form" })] })).cloudflareInterstitial,
    ]).toEqual([true, true, true, true]);
  });

  it("finds one-time code fields by autocomplete or name, not by a word that only contains otp", () => {
    expect([
      signals(doc([[el("input", { name: "code", autocomplete: "one-time-code" })]])).oneTimeCode,
      signals(doc([[el("input", { name: "verification_code" })]])).oneTimeCode,
      signals(doc([[el("input", { name: "mfa-token" })]])).oneTimeCode,
      signals(doc([[el("input", { name: "hotpot_preference" })]])).oneTimeCode,
    ]).toEqual([true, true, true, false]);
  });

  it("counts password fields and sign-up words", () => {
    const page = doc(
      [
        [
          el("input", { name: "pw", type: "password" }),
          el("input", { name: "pw2", type: "PASSWORD" }),
        ],
      ],
      { text: "Create an account to continue" },
    );
    expect([signals(page).passwordFields, signals(page).signUpWords]).toEqual([2, true]);
  });
});

describe("chooseOptions", () => {
  it("checks exactly the labelled options and unchecks the rest", () => {
    const remote = el("input", { name: "loc", type: "checkbox" }, { label: "Remote" });
    const nyc = el(
      "input",
      { name: "loc", type: "checkbox" },
      { label: "New York", checked: true },
    );
    const other = el("input", { name: "other", type: "checkbox" }, { label: "Remote" });
    const page = doc([[remote, nyc, other]]);
    const found = chooseOptions({ formIndex: 0, name: "loc", labels: ["Remote"] }, page);
    expect([found, remote.checked, nyc.checked, other.clicks]).toEqual([1, true, false, 0]);
  });

  it("finds nothing in a form that isn't there", () => {
    expect(chooseOptions({ formIndex: 3, name: "loc", labels: ["Remote"] }, doc([]))).toBe(0);
  });
});

describe("checkCollected", () => {
  const good = () => collectPage(null, GREENHOUSE_PAGE());

  it("passes what collectPage returns through unchanged", () => {
    expect(checkCollected(good())).toEqual(good());
  });

  it.each([
    ["no result", () => null],
    [
      "a name that isn't a string",
      () => ({ ...good(), forms: [[{ ...good().forms[1]?.[0], name: 7 }]] }),
    ],
    [
      "a string over the limit",
      () => ({
        ...good(),
        forms: [[{ ...good().forms[1]?.[0], name: "x".repeat(COLLECT_LIMITS.chars + 1) }]],
      }),
    ],
    [
      "too many forms",
      () => ({ ...good(), forms: Array.from({ length: COLLECT_LIMITS.forms + 1 }, () => []) }),
    ],
    [
      "too many controls across forms",
      () => ({
        ...good(),
        forms: [
          Array.from({ length: COLLECT_LIMITS.controls }, () => good().forms[1]?.[0]),
          [good().forms[1]?.[0]],
        ],
      }),
    ],
    [
      "a flag that isn't a boolean",
      () => ({ ...good(), signals: { ...good().signals, visibleCaptcha: "no" } }),
    ],
    [
      "a negative password count",
      () => ({ ...good(), signals: { ...good().signals, passwordFields: -1 } }),
    ],
  ])("refuses %s", (_name, make) => {
    expect(() => checkCollected(make())).toThrow(/^the page reported /);
  });
});
