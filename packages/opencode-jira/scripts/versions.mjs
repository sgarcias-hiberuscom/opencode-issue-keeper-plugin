import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import Database from "better-sqlite3";

const own = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
let opencodeAvailable = "not-installed";
try { opencodeAvailable = execFileSync("opencode", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
const sdk = JSON.parse(await readFile(new URL("../node_modules/@opencode/plugin/package.json", import.meta.url), "utf8")).version;
const driver = JSON.parse(await readFile(new URL("../node_modules/better-sqlite3/package.json", import.meta.url), "utf8")).version;
const database = new Database(":memory:");
let sqlite;
try { sqlite = database.prepare("SELECT sqlite_version() AS version").get().version; }
finally { database.close(); }
const markdown = Object.fromEntries(await Promise.all(["mdast-util-from-markdown", "mdast-util-gfm-table", "micromark-extension-gfm-table"].map(async (name) => [name, JSON.parse(await readFile(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8")).version])));
const record = { package: own.version, node: process.version, sdkDeclared: own.dependencies["@opencode/plugin"], sdk, storage: { driver: `better-sqlite3@${driver}`, sqlite }, markdown, opencodeAvailable, opencodeRuntimeValidated: false };
await mkdir("reports/mock", { recursive: true });
await writeFile("reports/mock/versions.json", `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record));
