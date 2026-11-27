import {
  type Fill,
  type FillResult,
  type FillTarget,
  filledMessage,
  fillTarget,
  type PrefillPackage,
  packageRequest,
  prefillMessage,
  prefillPlan,
} from "./prefill.js";
import type { Settings } from "./settings.js";

// The popup's "Fill this form" (NS-192 slice 4, ADR-0030): the code Paul pasted from the "Needs
// your hands" card, sent once, then the fill on the tab he is on. Plain code over ports so tests
// use fakes; popup.ts only wires it to Chrome. The code is never stored or logged.

// The handoff's UUID, a dot, then the grant: 32 random bytes in base64url (apps/api/src/prefill.ts).
const CODE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i;

export function parsePrefillCode(raw: string): { handoffId: string; grant: string } | null {
  const match = CODE.exec(raw.trim());
  if (!match?.[1] || !match[2]) return null;
  return { handoffId: match[1].toLowerCase(), grant: match[2] };
}

export type PrefillPorts = {
  // The stored settings, checked like capture's (checkSettings).
  settings: () => Promise<{ ok: true; settings: Settings } | { ok: false; message: string }>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  // The active tab as Chrome reports it now (activeTab gives its URL after Paul's click).
  activeTab: () => Promise<{ id?: number; url?: string } | undefined>;
  // fillForm injected into that tab's main frame only, re-checking `at` in the page; null when
  // Chrome refused.
  inject: (tabId: number, fills: Fill[], at: FillTarget) => Promise<FillResult | null>;
};

export const BAD_CODE_MESSAGE =
  "That isn't a pre-fill code. Copy it again from Needs your hands in Northstar.";
const NO_TAB_MESSAGE = "There is no form open to fill.";
const UNREACHABLE_MESSAGE = "Couldn't reach Northstar. Is the API running?";
const NOT_FILLED_MESSAGE = "Chrome didn't let the extension fill this page, so nothing was filled.";

// The answer's shape, checked before prefillPlan reads it: a wrong answer from the API ends in a
// message instead of an exception that leaves the popup on "Filling…".
function looksLikePackage(body: unknown): body is PrefillPackage {
  if (body === null || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  const c = b.contact as Record<string, unknown> | null | undefined;
  return (
    typeof b.ats === "string" &&
    typeof b.applyUrl === "string" &&
    typeof b.fields === "object" &&
    b.fields !== null &&
    typeof c === "object" &&
    c !== null &&
    typeof c.firstName === "string" &&
    typeof c.lastName === "string" &&
    typeof c.email === "string" &&
    (c.phone === null || typeof c.phone === "string")
  );
}

export async function runPrefill(rawCode: string, ports: PrefillPorts): Promise<string> {
  // A bad code sends nothing, so a typo never uses up a grant.
  const code = parsePrefillCode(rawCode);
  if (code === null) return BAD_CODE_MESSAGE;
  const checked = await ports.settings();
  if (!checked.ok) return `${checked.message} Open the extension's options.`;

  const { url, init } = packageRequest(checked.settings, code.handoffId, code.grant);
  let res: Response;
  try {
    res = await ports.fetch(url, init);
  } catch {
    return UNREACHABLE_MESSAGE;
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error =
      body !== null && typeof body === "object" && "error" in body ? String(body.error) : "";
    return prefillMessage(error);
  }
  if (!looksLikePackage(body)) return prefillMessage("bad_answer");
  const pkg = body;

  // The tab is read again here, after the network wait, so a tab Paul switched to meanwhile is
  // the one checked, and the fill goes to that same tab id.
  const tab = await ports.activeTab();
  if (tab?.id === undefined || tab.url === undefined) return NO_TAB_MESSAGE;
  const plan = prefillPlan(pkg, tab.url);
  if (!plan.ok) return prefillMessage(plan.refusal);
  const at = fillTarget(tab.url);
  if (at === null) return prefillMessage("not_https");
  const result = await ports.inject(tab.id, plan.fills, at).catch(() => null);
  if (result === null) return NOT_FILLED_MESSAGE;
  // The page navigated away between the check and the fill: nothing was touched.
  if (result.moved) return prefillMessage("wrong_page");
  return filledMessage(result);
}
