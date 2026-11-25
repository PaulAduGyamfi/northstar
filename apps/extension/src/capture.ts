import type { Settings } from "./settings.js";

// The plain logic behind "Save to Northstar" (NS-128): what is taken from the page, the request
// to the API, and what Paul is told. popup.ts only wires these to the browser.

// The API takes at most this much page text (MAX_PAGE_TEXT in apps/api/src/capture.ts).
export const MAX_TEXT = 20_000;
const MAX_TITLE = 500;

export type Page = { url: string; title: string; text: string };

// What is sent for the page, or null when there is nothing to send: only http(s) pages with
// text (never the browser's own chrome:// pages).
export function pageCapture(page: Page): Page | null {
  if (!/^https?:\/\//.test(page.url)) return null;
  const text = page.text.trim().slice(0, MAX_TEXT);
  if (text.length === 0) return null;
  const title = page.title.trim();
  return { url: page.url, title: title.length <= MAX_TITLE ? title : "", text };
}

// The request: JSON to the local API with the extension's own token, nothing else.
export function captureRequest(settings: Settings, page: Page): { url: string; init: RequestInit } {
  return {
    url: `${settings.apiOrigin}/jobs/capture`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.token}`,
      },
      body: JSON.stringify(page),
    },
  };
}

type Answer = {
  status?: string;
  found?: string[];
  missing?: string[];
  reason?: string | null;
};

// One plain sentence for the API's answer.
export function resultMessage(httpStatus: number, body: unknown): string {
  if (httpStatus === 401) {
    return "Northstar didn't accept the extension token. Check it in the extension's options.";
  }
  if (httpStatus !== 200 || typeof body !== "object" || body === null) {
    return "Couldn't reach Northstar. Is the API running?";
  }
  const a = body as Answer;
  switch (a.status) {
    case "created": {
      const found = a.found?.length ? ` Found: ${a.found.join(", ")}.` : "";
      const missing = a.missing?.length ? ` Missing: ${a.missing.join(", ")}.` : "";
      return `Saved to Northstar.${found}${missing}`;
    }
    case "merged":
      return "Saved: added as another source for a job already in Northstar.";
    case "unchanged":
      return "Already in Northstar.";
    case "refused":
      return `Not saved: ${a.reason ?? "refused"}.`;
    case "not_a_job":
      return "Not saved: Northstar couldn't find a job posting on this page.";
    case "failed":
      return `Not saved: ${a.reason ?? "reading the page failed"}. Try again in a minute.`;
    default:
      return "Couldn't reach Northstar. Is the API running?";
  }
}
