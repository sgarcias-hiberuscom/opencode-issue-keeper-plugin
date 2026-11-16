import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

let opencodeAvailable = "not-installed";
try { opencodeAvailable = execFileSync("opencode", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
const sdk = JSON.parse(await readFile(new URL("../node_modules/@opencode/plugin/package.json", import.meta.url), "utf8")).version;
const record = { node: process.version, sdk, opencodeAvailable, opencodeRuntimeValidated: false };
await mkdir("reports/mock", { recursive: true });
await writeFile("reports/mock/versions.json", `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record));
