// Copies the manifest and the HTML pages next to the compiled scripts, so dist/ is the folder
// Paul loads in chrome://extensions ("Load unpacked"). No bundler: tsc writes the scripts.
import { copyFile, mkdir, readdir } from "node:fs/promises";

const from = new URL("../static/", import.meta.url);
const to = new URL("../dist/", import.meta.url);
await mkdir(to, { recursive: true });
for (const name of await readdir(from)) await copyFile(new URL(name, from), new URL(name, to));
