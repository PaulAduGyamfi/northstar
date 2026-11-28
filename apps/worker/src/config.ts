import { isAbsolute } from "node:path";
import { type ApplyLimits, loadApplyLimits } from "@northstar/db";
import { loadVapidConfig, type VapidConfig } from "@northstar/gateways";
import { loadPoolLimits, type PoolLimits } from "./pools.js";

// The worker process's settings (NS-225), read in one place. The entry point passes its
// environment in; app code never reads `process.env` (AGENTS.md). An error names the setting and
// what it must be, never the value.

export type WorkerConfig = {
  // Temporal's gRPC frontend, `host:port`, on this machine only.
  temporalAddress: string;
  temporalNamespace: string;
  // The apply-browser pool runs only when Paul turns it on: off, nothing can be submitted.
  applyBrowser: { on: false } | { on: true; chromiumPath: string };
  pools: PoolLimits;
  applyLimits: ApplyLimits;
  // Web push (NS-193, ADR-0032): Paul's VAPID key pair, or null while push is off (unset).
  push: VapidConfig | null;
};

const DEFAULT_ADDRESS = "127.0.0.1:7233";
const DEFAULT_NAMESPACE = "default";
// The compose stack binds Temporal to 127.0.0.1 (NS-104) and the connection has no TLS, so only a
// literal loopback address is accepted (not `localhost`, which the hosts file can point
// anywhere): a typo can't send workflow traffic over the network.
const ADDRESS = /^(127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/;
const NAMESPACE = /^[A-Za-z0-9._-]{1,64}$/;

// Unset and empty both mean "use the default".
const raw = (env: Record<string, string | undefined>, name: string): string | undefined => {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
};

function address(env: Record<string, string | undefined>): string {
  const value = raw(env, "TEMPORAL_ADDRESS") ?? DEFAULT_ADDRESS;
  const m = ADDRESS.exec(value);
  const port = m ? Number(m[2]) : 0;
  if (!(port >= 1 && port <= 65535)) {
    throw new Error("TEMPORAL_ADDRESS: host:port on this machine (127.0.0.1 or [::1])");
  }
  return value;
}

function namespace(env: Record<string, string | undefined>): string {
  const value = raw(env, "TEMPORAL_NAMESPACE") ?? DEFAULT_NAMESPACE;
  if (!NAMESPACE.test(value)) {
    throw new Error("TEMPORAL_NAMESPACE: 1 to 64 letters, digits, '.', '_' or '-'");
  }
  return value;
}

function applyBrowser(env: Record<string, string | undefined>): WorkerConfig["applyBrowser"] {
  const value = raw(env, "WORKER_APPLY_BROWSER") ?? "off";
  if (value === "off") return { on: false };
  if (value !== "on") throw new Error("WORKER_APPLY_BROWSER: on or off");
  // playwright-core downloads no browser (ADR-0028): the installed one must be named.
  const chromiumPath = raw(env, "WORKER_CHROMIUM_PATH");
  if (chromiumPath === undefined || !isAbsolute(chromiumPath)) {
    throw new Error(
      "WORKER_CHROMIUM_PATH: the installed Chromium's absolute path, when the browser pool is on",
    );
  }
  return { on: true, chromiumPath };
}

export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  return {
    temporalAddress: address(env),
    temporalNamespace: namespace(env),
    applyBrowser: applyBrowser(env),
    pools: loadPoolLimits(env),
    applyLimits: loadApplyLimits(env),
    push: loadVapidConfig(env),
  };
}
