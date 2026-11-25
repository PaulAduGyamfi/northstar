import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { TestProject } from "vitest/node";
import * as schema from "../schema.js";

declare module "vitest" {
  export interface ProvidedContext {
    // Path of the migrated, empty PGlite data directory (a tar file) every test starts from.
    pgliteSnapshot: string;
  }
}

const migrationsFolder = fileURLToPath(new URL("../../migrations", import.meta.url));

// Runs once per `vitest run`, before any test file and outside Vitest's 10 s hook limit: apply
// every committed migration to an in-memory PGlite and save its data directory. Each test then
// starts its own PGlite from that file (createTestDb), so no test hook runs the migrations. CI
// runs every package's tests in parallel, and migrating inside the first beforeEach of each file
// passed the hook limit there (NS-111 follow-up).
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(tmpdir(), "northstar-pglite-"));
  const path = join(dir, "migrated.tar");
  const client = new PGlite({ extensions: { vector } });
  try {
    await migrate(drizzle({ client, schema }), { migrationsFolder });
    const dump = await client.dumpDataDir("none");
    await writeFile(path, Buffer.from(await dump.arrayBuffer()));
  } finally {
    await client.close();
  }
  project.provide("pgliteSnapshot", path);
  return () => rm(dir, { recursive: true, force: true });
}
