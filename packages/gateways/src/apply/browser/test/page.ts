import type { DomDocument } from "../collect.js";
import type { DriverLocator, DriverPage, DriverRoute } from "../driver.js";

// A scripted stand-in for a Playwright page (NS-142). Each URL serves a stand-in DOM; `evaluate`
// runs the driver's in-page functions on it, and clicking submit moves to `afterSubmit`. Every
// browser action is recorded so tests can assert what the driver did, and in what order.

export type Action = { action: string; selector?: string; value?: unknown };

export type FakePage = DriverPage & {
  actions: Action[];
  routeHandler: () => ((route: DriverRoute) => Promise<void>) | null;
  popups: { closed: boolean }[];
  firePopup: () => void;
  closed: () => boolean;
  defaultTimeout: () => number | null;
  // Runs before the named action resolves (to close the driver mid-step, for instance).
  before: Map<string, () => Promise<void> | void>;
};

export const MAIN_FRAME = { frame: "main" };

export function fakePage(script: {
  pages: Record<string, () => DomDocument>;
  afterSubmit?: { url: string; page: () => DomDocument };
  // A server-side redirect: loading the key ends on the value (page.route never sees the hop).
  redirects?: Record<string, string>;
  submitButtons?: number;
}): FakePage {
  const actions: Action[] = [];
  const before = new Map<string, () => Promise<void> | void>();
  const popupListeners: ((p: { close(): Promise<void> }) => void)[] = [];
  const popups: { closed: boolean }[] = [];
  let url = "about:blank";
  let dom: DomDocument | null = null;
  let handler: ((route: DriverRoute) => Promise<void>) | null = null;
  let isClosed = false;
  let timeoutMs: number | null = null;

  const step = async (action: string, selector?: string, value?: unknown) => {
    await before.get(action)?.();
    if (isClosed) throw new Error("Target page, context or browser has been closed");
    actions.push({
      action,
      ...(selector === undefined ? {} : { selector }),
      ...(value === undefined ? {} : { value }),
    });
  };

  const locator = (selector: string): DriverLocator => ({
    nth: (i) => locator(`${selector} >> nth=${i}`),
    locator: (inner) => locator(`${selector} >> ${inner}`),
    count: async () => {
      await step("count", selector);
      // The page's forms, or the form's submit buttons.
      if (selector === "xpath=//form") return dom?.forms.length ?? 0;
      return script.submitButtons ?? 1;
    },
    fill: async (value) => step("fill", selector, value),
    selectOption: async (values) => {
      await step("selectOption", selector, values);
      return [];
    },
    setInputFiles: async (files) =>
      step(
        "setInputFiles",
        selector,
        files.map((f) => ({ name: f.name, mimeType: f.mimeType, bytes: f.buffer.length })),
      ),
    click: async () => {
      await step("click", selector);
      if (script.afterSubmit) {
        url = script.afterSubmit.url;
        dom = script.afterSubmit.page();
      }
    },
  });

  return {
    actions,
    before,
    popups,
    routeHandler: () => handler,
    closed: () => isClosed,
    defaultTimeout: () => timeoutMs,
    setDefaultTimeout: (ms) => {
      timeoutMs = ms;
    },
    firePopup: () => {
      const popup = { closed: false };
      popups.push(popup);
      for (const listener of popupListeners) {
        listener({
          close: async () => {
            popup.closed = true;
          },
        });
      }
    },
    goto: async (to) => {
      await step("goto", undefined, to);
      const landed = script.redirects?.[to] ?? to;
      const page = script.pages[landed];
      if (!page) throw new Error(`no synthetic page at ${landed}`);
      url = landed;
      dom = page();
      return null;
    },
    url: () => url,
    evaluate: async <R, Arg>(fn: (arg: Arg) => R, arg: Arg): Promise<R> => {
      await step("evaluate", undefined, fn.name);
      if (dom === null) throw new Error("nothing loaded");
      // The in-page functions take the document as an optional second argument (tests only).
      return (fn as unknown as (a: Arg, d: DomDocument) => R)(arg, dom);
    },
    content: async () => {
      await step("content");
      return `<html><body>synthetic page at ${url}</body></html>`;
    },
    screenshot: async () => {
      await step("screenshot");
      return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    },
    route: async (pattern, h) => {
      await step("route", pattern);
      handler = h;
      return null;
    },
    mainFrame: () => MAIN_FRAME,
    locator,
    waitForLoadState: async (state) => step("waitForLoadState", undefined, state),
    on: (_event, listener) => {
      popupListeners.push(listener);
      return null;
    },
    close: async () => {
      isClosed = true;
      actions.push({ action: "close" });
    },
  };
}

// A route for one request, recording whether the driver aborted it or let it through.
export function fakeRoute(url: string, navigation: boolean, frame: unknown = MAIN_FRAME) {
  const result = { aborted: null as string | null, fellBack: false };
  const route: DriverRoute = {
    request: () => ({ url: () => url, isNavigationRequest: () => navigation, frame: () => frame }),
    abort: async (code) => {
      result.aborted = code ?? "failed";
    },
    fallback: async () => {
      result.fellBack = true;
    },
  };
  return { route, result };
}
