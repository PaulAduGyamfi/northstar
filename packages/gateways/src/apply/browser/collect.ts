import type { Challenge, FormField } from "../driver.js";

// Reading an application page (NS-142). `collectPage` and `chooseOptions` run INSIDE the page
// (Playwright's `page.evaluate` sends their source), so each is one self-contained function: no
// imports, no helpers outside its own body. They are written against the small DOM shape below,
// so their tests run in Node on plain objects. `toFields` and `challengeOf` are plain code over
// what `collectPage` returns. The markers are hand-written and must be checked against recorded
// pages (the rest of #76).

// The few DOM members the in-page functions touch.
export type DomElement = {
  tagName: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  // A select's options.
  options?: ArrayLike<{ text: string; value: string }>;
  // A radio's or checkbox's labels.
  labels?: ArrayLike<{ textContent: string | null }> | null;
  checked?: boolean;
  click?(): void;
};
// `getElementsByTagName` finds the form's descendants: the same buttons the driver's click locator
// searches (a CSS search inside the form), which `elements` may not be (a `form="…"` attribute
// moves a button in or out of `elements` without moving it in the page).
export type DomForm = {
  elements: ArrayLike<DomElement>;
  getElementsByTagName(name: string): ArrayLike<DomElement>;
};
export type DomDocument = {
  title: string;
  forms: ArrayLike<DomForm>;
  getElementsByTagName(name: string): ArrayLike<DomElement>;
  body: { textContent: string | null } | null;
};

// The page's own `document` when the function runs in the browser. Tests pass a plain object.
declare const document: DomDocument;

// One named control of a form, as the page shows it.
export type RawControl = {
  tag: string;
  type: string;
  name: string;
  required: boolean;
  // A select's option labels, or a radio's / checkbox's own label.
  options: string[];
};

// What `challengeOf` decides from. Counts and flags only: never page text.
export type ChallengeSignals = {
  visibleCaptcha: boolean;
  cloudflareInterstitial: boolean;
  passwordFields: number;
  oneTimeCode: boolean;
  signUpWords: boolean;
};

// What else a form holds that the driver can't fill or press safely (NS-255, from recorded
// Greenhouse and Lever forms). Counts and flags only.
export type FormFacts = {
  // Answerable controls (not hidden, not a button) with no name: the driver fills by name.
  unnamedFields: number;
  // react-select style dropdowns: an input with role="combobox", not a native select.
  comboboxes: number;
  // Every control `SUBMIT_SELECTOR` would match, in order.
  submits: { hidden: boolean; captcha: boolean }[];
};

export type CollectedPage = {
  forms: RawControl[][];
  // One per form, in the same order.
  facts: FormFacts[];
  signals: ChallengeSignals;
};

// Runs in the page. `doc` is only for tests: in the browser it is undefined and `document` is used.
export function collectPage(_arg: null, doc?: DomDocument): CollectedPage {
  const d = doc ?? document;
  const clean = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
  const forms: RawControl[][] = [];
  const facts: FormFacts[] = [];
  // Hidden from sight: an attribute, a hiding class or an inline style (NS-255). Attributes only:
  // hiding by an ancestor or a stylesheet isn't seen here (Playwright's click then waits on a
  // display:none button and times out, a handoff), and opacity or off-screen placement isn't.
  const hiddenClasses = [" hidden ", " visually-hidden ", " sr-only ", " d-none "];
  const isHidden = (el: DomElement): boolean => {
    const classes = ` ${clean(el.getAttribute("class")).toLowerCase()} `;
    const style = clean(el.getAttribute("style")).toLowerCase().replace(/\s/g, "");
    return (
      el.hasAttribute("hidden") ||
      el.getAttribute("aria-hidden") === "true" ||
      hiddenClasses.some((c) => classes.includes(c)) ||
      style.includes("display:none") ||
      style.includes("visibility:hidden")
    );
  };
  // Tied to a CAPTCHA: the word in its id, class or callback, or a site key.
  const isCaptcha = (el: DomElement): boolean =>
    /captcha/i.test(
      `${el.getAttribute("id") ?? ""} ${el.getAttribute("class") ?? ""} ${el.getAttribute("data-callback") ?? ""}`,
    ) || el.hasAttribute("data-sitekey");
  for (let f = 0; f < d.forms.length; f++) {
    const form = d.forms[f];
    if (!form) continue;
    const controls: RawControl[] = [];
    const fact: FormFacts = { unnamedFields: 0, comboboxes: 0, submits: [] };
    for (let i = 0; i < form.elements.length; i++) {
      const el = form.elements[i];
      if (!el) continue;
      const tag = el.tagName.toLowerCase();
      const rawType = clean(el.getAttribute("type")).toLowerCase();
      if (el.getAttribute("role") === "combobox") fact.comboboxes++;
      const name = el.getAttribute("name");
      if (!name) {
        const answerable =
          tag === "select" ||
          tag === "textarea" ||
          (tag === "input" && !["hidden", "submit", "button", "reset", "image"].includes(rawType));
        if (answerable) fact.unnamedFields++;
        continue;
      }
      const type = rawType || (tag === "input" ? "text" : tag);
      const options: string[] = [];
      if (tag === "select" && el.options) {
        for (let o = 0; o < el.options.length; o++) {
          const opt = el.options[o];
          // An empty value is the "Please select" placeholder, not a choice.
          if (opt && opt.value !== "") options.push(clean(opt.text));
        }
      } else if (type === "radio" || type === "checkbox") {
        const label = el.labels && el.labels.length > 0 ? el.labels[0]?.textContent : null;
        options.push(clean(label) || clean(el.getAttribute("value")));
      }
      controls.push({
        tag,
        type,
        name,
        required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
        options,
      });
    }
    // Submit candidates from the form's descendants, the place the driver's click locator searches,
    // so the button judged here is the button that would be pressed. At least SUBMIT_SELECTOR's set
    // (button[type=submit], input[type=submit], a button with no type), conservatively: an empty
    // type counts too, which can only refuse more.
    for (const tagName of ["button", "input"]) {
      const found = form.getElementsByTagName(tagName);
      for (let i = 0; i < found.length; i++) {
        const el = found[i];
        if (!el) continue;
        const type = clean(el.getAttribute("type")).toLowerCase();
        if (tagName === "button" ? type === "submit" || type === "" : type === "submit") {
          fact.submits.push({ hidden: isHidden(el), captcha: isCaptcha(el) });
        }
      }
    }
    forms.push(controls);
    facts.push(fact);
  }
  const all = d.getElementsByTagName("*");
  let visibleCaptcha = false;
  let cloudflareInterstitial = /^just a moment/i.test(clean(d.title));
  let passwordFields = 0;
  let oneTimeCode = false;
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (!el) continue;
    const classes = ` ${clean(el.getAttribute("class"))} `;
    const invisible = el.getAttribute("data-size") === "invisible";
    // A widget Paul would have to solve. Invisible reCAPTCHA shows nothing to solve. hCaptcha
    // counts even when marked invisible: it can still put up a puzzle, and Lever sets its size by
    // script, so the attribute can't be trusted (NS-255, the conservative reading of ADR-0003).
    if (classes.includes(" g-recaptcha ") && !invisible) visibleCaptcha = true;
    if (classes.includes(" h-captcha ")) visibleCaptcha = true;
    if (classes.includes(" cf-turnstile ")) visibleCaptcha = true;
    const id = el.getAttribute("id") ?? "";
    if (id === "challenge-form" || id === "cf-challenge-running") cloudflareInterstitial = true;
    if (el.tagName.toLowerCase() === "input") {
      const type = clean(el.getAttribute("type")).toLowerCase();
      if (type === "password") passwordFields++;
      const key = `${el.getAttribute("name") ?? ""} ${id}`;
      if (
        el.getAttribute("autocomplete") === "one-time-code" ||
        /(^|[^a-z])(otp|mfa|2fa)([^a-z]|$)|one[-_ ]?time|verification[-_ ]?code/i.test(key)
      ) {
        oneTimeCode = true;
      }
    }
  }
  const text = clean(d.body?.textContent);
  const signUpWords = /create (an |your )?account|sign up|register/i.test(text);
  return {
    forms,
    facts,
    signals: { visibleCaptcha, cloudflareInterstitial, passwordFields, oneTimeCode, signUpWords },
  };
}

// Runs in the page: in form `formIndex`, makes exactly the radios/checkboxes named `name` whose
// label is in `labels` checked (clicking, so the page's own handlers see it), and the rest
// unchecked. Returns how many of `labels` it found. `doc` is only for tests.
export function chooseOptions(
  arg: { formIndex: number; name: string; labels: string[] },
  doc?: DomDocument,
): number {
  const d = doc ?? document;
  const clean = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
  const form = d.forms[arg.formIndex];
  if (!form) return 0;
  let found = 0;
  for (let i = 0; i < form.elements.length; i++) {
    const el = form.elements[i];
    if (!el || el.getAttribute("name") !== arg.name) continue;
    const label = el.labels && el.labels.length > 0 ? el.labels[0]?.textContent : null;
    const text = clean(label) || clean(el.getAttribute("value"));
    const want = arg.labels.includes(text);
    if (want) found++;
    if (Boolean(el.checked) !== want && el.click) el.click();
  }
  return found;
}

// Limits on what a page may report. Real application forms are far smaller; a page past them is
// refused instead of filling the worker's memory.
export const COLLECT_LIMITS = { forms: 50, controls: 500, options: 200, chars: 1000 } as const;

class CollectedError extends Error {
  override name = "DriverError";
}

// `collectPage` runs beside the page's own script, which can redefine the DOM members it reads,
// so its answer is checked here in Node: the exact shape, strings and booleans only, and the
// limits above. Anything else throws (a `driver_error` handoff in the gateway).
export function checkCollected(value: unknown): CollectedPage {
  const fail = (what: string): never => {
    throw new CollectedError(`the page reported ${what}`);
  };
  const str = (v: unknown): string =>
    typeof v === "string" && v.length <= COLLECT_LIMITS.chars ? v : fail("a bad string");
  const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : fail("a bad flag"));
  const list = (v: unknown, max: number): unknown[] =>
    Array.isArray(v) && v.length <= max ? v : fail("a bad list");
  const obj = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : fail("a bad object");
  const page = obj(value);
  const signals = obj(page.signals);
  const passwordFields = signals.passwordFields;
  if (
    typeof passwordFields !== "number" ||
    !Number.isInteger(passwordFields) ||
    passwordFields < 0
  ) {
    fail("a bad count");
  }
  let controls = 0;
  const forms = list(page.forms, COLLECT_LIMITS.forms).map((form) =>
    list(form, COLLECT_LIMITS.controls).map((raw): RawControl => {
      controls++;
      if (controls > COLLECT_LIMITS.controls) fail("too many controls");
      const c = obj(raw);
      return {
        tag: str(c.tag),
        type: str(c.type),
        name: str(c.name),
        required: bool(c.required),
        options: list(c.options, COLLECT_LIMITS.options).map(str),
      };
    }),
  );
  const count = (v: unknown): number =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= COLLECT_LIMITS.controls
      ? v
      : fail("a bad count");
  let submitTotal = 0;
  const facts = list(page.facts, COLLECT_LIMITS.forms).map((raw): FormFacts => {
    const f = obj(raw);
    return {
      unnamedFields: count(f.unnamedFields),
      comboboxes: count(f.comboboxes),
      submits: list(f.submits, COLLECT_LIMITS.controls).map((s) => {
        // A total across every form, as for controls.
        submitTotal++;
        if (submitTotal > COLLECT_LIMITS.controls) fail("too many submit buttons");
        const b = obj(s);
        return { hidden: bool(b.hidden), captcha: bool(b.captcha) };
      }),
    };
  });
  // One set of facts per form, or the answer isn't the reader's own.
  if (facts.length !== forms.length) fail("facts that don't match its forms");
  return {
    forms,
    facts,
    signals: {
      visibleCaptcha: bool(signals.visibleCaptcha),
      cloudflareInterstitial: bool(signals.cloudflareInterstitial),
      passwordFields: passwordFields as number,
      oneTimeCode: bool(signals.oneTimeCode),
      signUpWords: bool(signals.signUpWords),
    },
  };
}

// Input types that read as plain text to the adapters.
const TEXT_TYPES = new Set(["text", "url", "number", "date", "search", "month", "week", "time"]);
const KEPT_TYPES = new Set(["email", "tel", "file", "hidden"]);

// Controls → the gateway's FormFields: a radio or checkbox group is one field with every label as
// an option; buttons, passwords and anything else unknown are left out.
export function toFields(controls: readonly RawControl[]): FormField[] {
  const fields: FormField[] = [];
  const groups = new Map<string, FormField & { options: string[] }>();
  for (const c of controls) {
    if (c.tag === "select") {
      fields.push({ name: c.name, type: "select", required: c.required, options: [...c.options] });
    } else if (c.tag === "textarea") {
      fields.push({ name: c.name, type: "textarea", required: c.required });
    } else if (c.tag === "input" && (c.type === "radio" || c.type === "checkbox")) {
      const group = groups.get(c.name);
      if (group && group.type === c.type) {
        group.options.push(...c.options);
        group.required = group.required || c.required;
      } else if (!group) {
        const field = {
          name: c.name,
          type: c.type as "radio" | "checkbox",
          required: c.required,
          options: [...c.options],
        };
        groups.set(c.name, field);
        fields.push(field);
      }
    } else if (c.tag === "input" && TEXT_TYPES.has(c.type)) {
      fields.push({ name: c.name, type: "text", required: c.required });
    } else if (c.tag === "input" && KEPT_TYPES.has(c.type)) {
      fields.push({ name: c.name, type: c.type as FormField["type"], required: c.required });
    }
  }
  return fields;
}

// Something only Paul's hands may get past (ADR-0003), or null. Never solved, never worked around.
export function challengeOf(s: ChallengeSignals): Challenge | null {
  if (s.visibleCaptcha || s.cloudflareInterstitial) return "captcha";
  if (s.oneTimeCode) return "mfa";
  if (s.passwordFields >= 2 || (s.passwordFields === 1 && s.signUpWords)) return "account";
  if (s.passwordFields === 1) return "login";
  return null;
}

// Why the driver must not fill or submit a form, or null (NS-255). Refuse, never handle: each of
// these is a form shape the recorded Greenhouse or Lever pages showed, which the driver would
// fill wrongly (a field it can't name, a dropdown that isn't a select) or submit through the wrong
// button (a hidden one, one a CAPTCHA script presses, or a type="button" it doesn't press).
export const FORM_PROBLEMS = [
  "unnamed_fields",
  "combobox",
  "no_submit",
  "several_submits",
  "hidden_submit",
  "captcha_submit",
] as const;
export type FormProblem = (typeof FORM_PROBLEMS)[number];

export function formProblem(f: FormFacts): FormProblem | null {
  if (f.unnamedFields > 0) return "unnamed_fields";
  if (f.comboboxes > 0) return "combobox";
  if (f.submits.some((s) => s.captcha)) return "captcha_submit";
  if (f.submits.some((s) => s.hidden)) return "hidden_submit";
  if (f.submits.length === 0) return "no_submit";
  if (f.submits.length > 1) return "several_submits";
  return null;
}

// The form to fill: the one with the most fields (an ATS page may also carry a search or
// newsletter form). Null when the page has none.
export function pickForm(
  forms: readonly RawControl[][],
): { index: number; fields: FormField[] } | null {
  let best: { index: number; fields: FormField[] } | null = null;
  for (const [index, controls] of forms.entries()) {
    const fields = toFields(controls);
    if (fields.length > 0 && (best === null || fields.length > best.fields.length)) {
      best = { index, fields };
    }
  }
  return best;
}
