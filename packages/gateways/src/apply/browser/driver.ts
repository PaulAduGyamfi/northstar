import { trace } from "@opentelemetry/api";
import type { Fill, FormDriver, FormField, PageState, Upload } from "../driver.js";
import {
  challengeOf,
  checkCollected,
  chooseOptions,
  collectPage,
  formProblem,
  pickForm,
} from "./collect.js";

// Why a form was refused (NS-255), on the gateway's active `apply.submit` span: a fixed code only.
const FORM_PROBLEM = "northstar.apply.form_problem";

// The Playwright form driver (NS-142, APPLY-008): `FormDriver` over one browser page. It only
// reports what it sees (ADR-0003): a CAPTCHA, sign-in, one-time code or account wall comes back
// as a challenge, never solved. It never leaves the adapter's hosts, and once `close()` is
// called no step runs another browser action, so a timed-out submit can't press the button late.

// The members of Playwright's Page, Locator, Route and Request the driver uses. A real Page
// satisfies them (`launch.ts`); tests use a fake.
export interface DriverLocator {
  nth(index: number): DriverLocator;
  locator(selector: string): DriverLocator;
  count(): Promise<number>;
  fill(value: string): Promise<void>;
  selectOption(values: { label: string }[]): Promise<string[]>;
  setInputFiles(files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void>;
  click(): Promise<void>;
}
export interface DriverRoute {
  request(): { url(): string; isNavigationRequest(): boolean; frame(): unknown };
  abort(errorCode?: string): Promise<void>;
  fallback(): Promise<void>;
}
export interface DriverPage {
  goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
  url(): string;
  evaluate<R, Arg>(fn: (arg: Arg) => R, arg: Arg): Promise<R>;
  content(): Promise<string>;
  screenshot(options: { fullPage: boolean; type: "png" }): Promise<Buffer>;
  route(url: string, handler: (route: DriverRoute) => Promise<void>): Promise<unknown>;
  mainFrame(): unknown;
  locator(selector: string): DriverLocator;
  waitForLoadState(state: "networkidle", options: { timeout: number }): Promise<void>;
  on(event: "popup", listener: (popup: { close(): Promise<void> }) => void): unknown;
  close(): Promise<void>;
  // Every action's own limit, so a click waiting on a disabled button can't outlive the step.
  setDefaultTimeout(timeout: number): void;
}

export type DriverOptions = {
  page: DriverPage;
  // The adapter's own hosts (`AtsAdapter.hosts`): the only ones the page may navigate to.
  hosts: readonly string[];
  // Each browser step's own limit; the gateway also puts its limits around open and submit.
  stepTimeoutMs?: number;
  // What `close()` ends: the page by default; `launchFormDriver` closes its browser too.
  onClose?: () => Promise<void>;
};

// Thrown for anything the driver refuses. Messages name fields and counts, never a value.
export class DriverError extends Error {
  override name = "DriverError";
}

const DEFAULT_STEP_TIMEOUT_MS = 60_000;
// The form's submit control. Exactly one must match, or the driver won't guess which to press.
// The page's forms outside shadow roots, in document order: the same forms, in the same order, as
// `document.forms` in `collectPage` (a CSS `form` selector would also count forms inside shadow
// roots and shift the index onto another form).
const FORMS = "xpath=//form";
const SUBMIT_SELECTOR = 'button[type="submit"], input[type="submit"], button:not([type])';
const TEXT_LIKE = new Set<FormField["type"]>(["text", "email", "tel", "textarea"]);
const MIME: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
};

// Is this URL on one of the hosts, over https, with no port or credentials? Same rule as the
// gateway's `hostAllowed`, for navigations the gateway never sees (redirects, scripts).
export function onHosts(hosts: readonly string[], url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    hosts.includes(parsed.hostname)
  );
}

// A CSS attribute selector for a form's own field name. A name with a control character is
// refused rather than escaped.
function byName(name: string): string {
  if (/[\p{Cc}]/u.test(name)) throw new DriverError("a field name has a control character");
  return `[name="${name.replace(/["\\]/g, "\\$&")}"]`;
}

const mimeOf = (fileName: string): string =>
  MIME[fileName.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

export function createPlaywrightDriver(options: DriverOptions): FormDriver {
  const { page, hosts } = options;
  if (hosts.length === 0) throw new DriverError("the driver needs the adapter's hosts");
  const timeout = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  page.setDefaultTimeout(timeout);
  let closed = false;
  let routed = false;
  // The form `open` found: its index among the page's forms and its fields by name.
  // `count` is how many forms the page had then, checked again before anything is typed.
  let form: { index: number; count: number; fields: Map<string, FormField> } | null = null;

  // Called before every browser action: after close, nothing more happens on the page.
  const guard = (): void => {
    if (closed) throw new DriverError("the driver was closed");
  };

  // Aborts any main-frame navigation off the hosts. Subresources (scripts, fonts) may come
  // from elsewhere; only the page itself must stay on the ATS.
  async function keepOnHosts(): Promise<void> {
    if (routed) return;
    routed = true;
    page.on("popup", (popup) => {
      void popup.close().catch(() => {});
    });
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame() &&
        !onHosts(hosts, request.url())
      ) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.fallback();
    });
  }

  // The page as the gateway sees it. `formAllowed` is false after submit: whatever follows is
  // proof material or a challenge, never a form to fill again.
  async function snapshot(formAllowed: boolean): Promise<PageState> {
    guard();
    // `page.route` doesn't see a server's redirect hops, and some navigations (about:blank, an
    // aborted load's error page) never make a request: so check where the page actually is.
    if (!onHosts(hosts, page.url())) throw new DriverError("the page left the adapter's hosts");
    // The page's own script runs alongside the reader, so its answer is checked, not trusted.
    const collected = checkCollected(await page.evaluate(collectPage, null));
    const challenge = challengeOf(collected.signals);
    if (challenge !== null) return { kind: "challenge", challenge };
    if (formAllowed) {
      const picked = pickForm(collected.forms);
      // A form the driver can't fill or submit safely is no form (NS-255): the gateway hands off
      // with form_changed, before anything is typed or pressed. Only the code goes on the span.
      const facts = picked === null ? undefined : collected.facts[picked.index];
      const problem = facts === undefined ? null : formProblem(facts);
      if (problem !== null) trace.getActiveSpan()?.setAttribute(FORM_PROBLEM, problem);
      if (picked !== null && problem === null) {
        form = {
          index: picked.index,
          count: collected.forms.length,
          fields: new Map(picked.fields.map((f) => [f.name, f])),
        };
        return { kind: "form", url: page.url(), fields: picked.fields };
      }
    }
    guard();
    const html = await page.content();
    guard();
    const screenshot = await page.screenshot({ fullPage: true, type: "png" });
    return { kind: "page", url: page.url(), html, screenshotPng: new Uint8Array(screenshot) };
  }

  async function fillOne(fill: Fill, index: number, field: FormField): Promise<void> {
    const values = typeof fill.value === "string" ? [fill.value] : [...fill.value];
    const target = page.locator(FORMS).nth(index).locator(byName(field.name));
    if (TEXT_LIKE.has(field.type)) {
      if (typeof fill.value !== "string") throw new DriverError(`${field.name} takes one value`);
      guard();
      await target.fill(fill.value);
      return;
    }
    if (field.type === "select" || field.type === "radio" || field.type === "checkbox") {
      const options = field.options ?? [];
      if (field.type !== "checkbox" && values.length !== 1) {
        throw new DriverError(`${field.name} takes one value`);
      }
      if (!values.every((v) => options.includes(v))) {
        throw new DriverError(`a value for ${field.name} isn't one of its options`);
      }
      guard();
      if (field.type === "select") {
        await target.selectOption(values.map((label) => ({ label })));
        return;
      }
      const found = await page.evaluate(chooseOptions, {
        formIndex: index,
        name: field.name,
        labels: values,
      });
      if (found !== values.length) throw new DriverError(`${field.name} lost an option`);
      return;
    }
    // Hidden fields belong to the ATS, and files come only as uploads.
    throw new DriverError(`${field.name} is a ${field.type} field and can't be filled`);
  }

  return {
    async open(url) {
      guard();
      if (!onHosts(hosts, url)) throw new DriverError("the apply URL isn't on the adapter's hosts");
      form = null;
      await keepOnHosts();
      guard();
      await page.goto(url, { waitUntil: "load", timeout });
      return snapshot(true);
    },

    async fillAndSubmit(fills: readonly Fill[], uploads: readonly Upload[]) {
      guard();
      if (form === null) throw new DriverError("no form is open");
      const { index, count, fields } = form;
      guard();
      const forms = await page.locator(FORMS).count();
      if (forms !== count) throw new DriverError(`the page now has ${forms} forms, not ${count}`);
      for (const fill of fills) {
        const field = fields.get(fill.field);
        if (!field) throw new DriverError(`the form has no field ${fill.field}`);
        await fillOne(fill, index, field);
      }
      for (const upload of uploads) {
        const field = fields.get(upload.field);
        if (field?.type !== "file")
          throw new DriverError(`the form has no file field ${upload.field}`);
        guard();
        await page
          .locator(FORMS)
          .nth(index)
          .locator(byName(field.name))
          .setInputFiles([
            {
              name: upload.fileName,
              mimeType: mimeOf(upload.fileName),
              buffer: Buffer.from(upload.bytes),
            },
          ]);
      }
      // The page's own script may have changed the form since `open` (NS-256): read it again just
      // before the one step that can't be taken back, and refuse a challenge, a different number
      // of forms, or a form that now has a problem. Nothing has been pressed yet.
      guard();
      if (!onHosts(hosts, page.url())) throw new DriverError("the page left the adapter's hosts");
      const again = checkCollected(await page.evaluate(collectPage, null));
      // A challenge is reported as one, like `open` does: the gateway hands it to Paul with its
      // deep link, and it is clear nothing was pressed (a DriverError would read "may have gone").
      const challenge = challengeOf(again.signals);
      if (challenge !== null) {
        form = null;
        return { kind: "challenge", challenge };
      }
      if (again.forms.length !== count) {
        throw new DriverError(`the page now has ${again.forms.length} forms, not ${count}`);
      }
      const nowFacts = again.facts[index];
      const nowProblem = nowFacts === undefined ? "no_submit" : formProblem(nowFacts);
      if (nowProblem !== null) {
        trace.getActiveSpan()?.setAttribute(FORM_PROBLEM, nowProblem);
        throw new DriverError(`the form changed before submit: ${nowProblem}`);
      }
      const submit = page.locator(FORMS).nth(index).locator(SUBMIT_SELECTOR);
      guard();
      const buttons = await submit.count();
      if (buttons !== 1) throw new DriverError(`the form has ${buttons} submit buttons, not one`);
      // The last check before the one step that can't be taken back.
      guard();
      await submit.click();
      form = null;
      // The button is pressed, so a page that never goes quiet (beacons, long polls) still gets
      // its snapshot: the gateway then decides from what is there, never from a timeout.
      // Known gap: on a single-page form that was already idle this returns at once, before the
      // confirmation renders (a `no_confirmation` handoff). Recorded pages decide the wait (#76).
      await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
      return snapshot(false);
    },

    async close() {
      if (closed) return;
      closed = true;
      await (options.onClose ?? (() => page.close()))();
    },
  };
}
