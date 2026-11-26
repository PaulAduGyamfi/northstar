import { type CallGuard, type GuardDecision, type GuardOutcome, HeldBack } from "@northstar/llm";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeEach, describe, expect, it } from "vitest";
import { GmailAccess } from "../oauth.js";
import { createLabelWriter, LabelInputError, LabelWriteError } from "./writer.js";

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
);
beforeEach(() => exporter.reset());

const TOKEN = "ya29.test-label-token";
type Req = { method: string; url: string; body: unknown };

// A fake Gmail with labels and threads. `createStatus` forces the next create's status (409 makes
// it act as if another run created the label first).
function fakeLabels(initial: { id: string; name: string }[] = []) {
  const labels = [...initial];
  const threadLabels = new Map<string, Set<string>>();
  const requests: Req[] = [];
  let nextId = 100;
  let createStatus: number | null = null;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, url, body });
    if (url.endsWith("/users/me/labels") && method === "GET") return json(200, { labels });
    if (url.endsWith("/users/me/labels") && method === "POST") {
      if (createStatus === 409) {
        createStatus = null;
        labels.push({ id: `Label_${nextId++}`, name: body.name });
        return json(409, { error: { errors: [{ reason: "duplicate" }] } });
      }
      if (createStatus !== null)
        return json(createStatus, {
          error: { errors: [{ reason: "backendError", message: "Label_7 secret text" }] },
        });
      const label = { id: `Label_${nextId++}`, name: body.name };
      labels.push(label);
      return json(200, label);
    }
    const m = /\/threads\/([^/]+)\/modify$/.exec(url);
    if (m && method === "POST") {
      const set = threadLabels.get(m[1] as string) ?? new Set<string>();
      for (const id of body.addLabelIds as string[]) set.add(id);
      threadLabels.set(m[1] as string, set);
      return json(200, { id: m[1] });
    }
    return json(404, {});
  }) as typeof fetch;
  return {
    fetch: fetchFn,
    requests,
    labels,
    threadLabels,
    failNextCreate: (status: number) => {
      createStatus = status;
    },
  };
}

function guardWith(on = true, decision: GuardDecision = { allowed: true, probe: false }) {
  const reports: { dependency: string; outcome: GuardOutcome }[] = [];
  const switches: string[] = [];
  const guard: CallGuard = {
    isOn: async (subsystem) => {
      switches.push(subsystem);
      return on;
    },
    acquire: async () => decision,
    report: async (dependency, outcome) => {
      reports.push({ dependency, outcome });
    },
  };
  return { guard, reports, switches };
}

const writerFor = (gmail: ReturnType<typeof fakeLabels>, guard: CallGuard) =>
  createLabelWriter({ access: new GmailAccess(TOKEN), fetch: gmail.fetch, guard });

describe("the label writer", () => {
  it("creates a missing label once and adds it to the thread with addLabelIds only", async () => {
    const gmail = fakeLabels([{ id: "Label_1", name: "Northstar/Outside" }]);
    const { guard } = guardWith();
    const writer = writerFor(gmail, guard);
    await expect(
      writer.labelThread("t1abc", ["Northstar/Confirmation", "Northstar/Outside"]),
    ).resolves.toEqual({ created: 1 });
    const creates = gmail.requests.filter((r) => r.method === "POST" && r.url.endsWith("/labels"));
    expect(creates.map((r) => r.body)).toEqual([
      {
        name: "Northstar/Confirmation",
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    ]);
    const modify = gmail.requests.at(-1);
    expect(modify?.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/threads/t1abc/modify");
    expect(modify?.body).toEqual({ addLabelIds: ["Label_100", "Label_1"] });
    expect([...(gmail.threadLabels.get("t1abc") ?? [])]).toEqual(["Label_100", "Label_1"]);
  });

  it("changes nothing more when the same labels are applied again", async () => {
    const gmail = fakeLabels();
    const writer = writerFor(gmail, guardWith().guard);
    await writer.labelThread("t1", ["Northstar/Offer"]);
    await expect(writer.labelThread("t1", ["Northstar/Offer"])).resolves.toEqual({ created: 0 });
    expect(gmail.labels).toHaveLength(1);
    expect(gmail.threadLabels.get("t1")?.size).toBe(1);
    // The label list is read once per writer.
    expect(gmail.requests.filter((r) => r.method === "GET")).toHaveLength(1);
  });

  it("lists again on a 409, when another run created the label first", async () => {
    const gmail = fakeLabels();
    gmail.failNextCreate(409);
    const writer = writerFor(gmail, guardWith().guard);
    await expect(writer.labelThread("t2", ["Northstar/Rejection"])).resolves.toEqual({
      created: 0,
    });
    expect(gmail.labels).toHaveLength(1);
    expect(gmail.requests.filter((r) => r.method === "GET")).toHaveLength(2);
    expect(gmail.threadLabels.get("t2")?.size).toBe(1);
  });

  it("never sends anything but list, create and an add-only modify", async () => {
    const gmail = fakeLabels();
    await writerFor(gmail, guardWith().guard).labelThread("t3", [
      "Northstar/Interview",
      "Northstar/Started-by-Northstar",
    ]);
    for (const r of gmail.requests) {
      expect(r.url).toMatch(/\/users\/me\/(labels|threads\/t3\/modify)$/);
      if (r.url.endsWith("/modify")) expect(Object.keys(r.body as object)).toEqual(["addLabelIds"]);
    }
  });

  it("does nothing for an empty list", async () => {
    const gmail = fakeLabels();
    await expect(writerFor(gmail, guardWith().guard).labelThread("t4", [])).resolves.toEqual({
      created: 0,
    });
    expect(gmail.requests).toEqual([]);
  });

  it.each([
    ["a name that isn't Northstar's", "t5", ["INBOX"]],
    ["a name from mail text", "t5", ["Northstar/Hired"]],
    ["a thread id with a path in it", "t5/../../messages/m1", ["Northstar/Offer"]],
  ])("refuses %s before any request", async (_what, threadId, names) => {
    const gmail = fakeLabels();
    await expect(
      writerFor(gmail, guardWith().guard).labelThread(threadId, names),
    ).rejects.toBeInstanceOf(LabelInputError);
    expect(gmail.requests).toEqual([]);
  });

  it("sends nothing while its kill switch is off", async () => {
    const gmail = fakeLabels();
    const { guard, switches } = guardWith(false);
    const error = await writerFor(gmail, guard)
      .labelThread("t6", ["Northstar/Offer"])
      .catch((e: unknown) => e);
    expect(error).toEqual(new HeldBack("kill_switch", "gmail_labels"));
    expect(switches).toEqual(["gmail_labels"]);
    expect(gmail.requests).toEqual([]);
  });

  it("sends nothing while the gmail breaker is open", async () => {
    const gmail = fakeLabels();
    const retryAt = new Date("2026-11-26T16:00:00Z");
    const { guard } = guardWith(true, { allowed: false, retryAt, lastError: null });
    const error = await writerFor(gmail, guard)
      .labelThread("t7", ["Northstar/Offer"])
      .catch((e: unknown) => e);
    expect(error).toEqual(new HeldBack("breaker", "gmail", retryAt));
    expect(gmail.requests).toEqual([]);
  });

  it("counts a 5xx against the breaker, and names only the status and reason code", async () => {
    const gmail = fakeLabels();
    gmail.failNextCreate(503);
    const { guard, reports } = guardWith();
    const error = await writerFor(gmail, guard)
      .labelThread("t8", ["Northstar/Offer"])
      .catch((e: unknown) => e);
    expect(error).toEqual(
      new LabelWriteError("create label: Gmail answered 503 (backendError)", 503),
    );
    expect(reports.map((r) => r.outcome)).toEqual([
      { ok: true },
      { ok: false, error: "LabelWriteError" },
    ]);
  });

  it("keeps the token, thread and label ids out of errors and spans", async () => {
    const gmail = fakeLabels();
    gmail.failNextCreate(503);
    const error = await writerFor(gmail, guardWith().guard)
      .labelThread("t9secret", ["Northstar/Offer"])
      .catch((e: unknown) => e);
    const spans = exporter.getFinishedSpans();
    const seen = JSON.stringify([String(error), spans.map((s) => [s.attributes, s.status])]);
    for (const secret of [TOKEN, "t9secret", "Label_7", "secret text"]) {
      expect(seen).not.toContain(secret);
    }
    expect(spans.map((s) => s.name)).toEqual(["gmail.label_thread"]);
  });
});
