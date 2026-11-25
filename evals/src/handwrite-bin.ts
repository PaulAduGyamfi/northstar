import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeHandwrittenFixtures } from "./handwrite.js";
import { registry } from "./routes.js";

// `node dist/handwrite-bin.js <route>`: writes evals/<route>/fixtures from the hand-written
// outputs in evals/<route>/handwritten.jsonl (one `{"id", "output"}` per case, in any order).
// Offline and free: no model is called. Agents use it for a new route (ADR-0016 item 8); Paul
// replaces the result with `eval <route> --record`.
const route = process.argv[2] ?? "";
const evalSet = Object.hasOwn(registry, route) ? registry[route] : undefined;
if (!evalSet) throw new Error(`unknown route: ${route}`);
const dir = join(fileURLToPath(new URL("..", import.meta.url)), route);
const jsonl = (name: string) =>
  readFileSync(join(dir, name), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { id: string; output?: unknown });
const cases = jsonl("cases.jsonl");
const outputs = new Map(jsonl("handwritten.jsonl").map((h) => [h.id, h.output]));
const missing = cases.filter((c) => !outputs.has(c.id)).map((c) => c.id);
if (missing.length > 0) throw new Error(`no hand-written output for: ${missing.join(", ")}`);
const report = await writeHandwrittenFixtures(
  evalSet,
  cases,
  cases.map((c) => outputs.get(c.id)),
  join(dir, "fixtures"),
  `Hand-written by an agent, not recorded from the model (ADR-0016 item 8). Replace with: eval ${route} --record.`,
);
for (const c of report.cases) console.log(`  ${c.passed ? "pass" : "FAIL"} ${c.id} (${c.outcome})`);
console.log(`${route}: ${report.passed}/${report.total} hand-written cases pass`);
