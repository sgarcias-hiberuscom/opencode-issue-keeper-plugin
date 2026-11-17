import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const variant = process.argv[2];
if (variant === undefined) {
  const results = await Promise.all(["tarball", "local"].map((source) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), source], { stdio: "inherit", timeout: 100000 });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ source, code, signal }));
  })));
  for (const result of results) assert.equal(result.code, 0, `Smoke ${result.source} incompleto (${result.signal ?? result.code}).`);
  console.log("Tarball aislado: ocho herramientas, base sin cuentas, CLI local/tgz, check y retirada comprobados.");
  process.exit(0);
}
assert(["tarball", "local"].includes(variant), "Variante de empaquetado desconocida.");

const directory = await mkdtemp("/tmp/opencode/issuekeeper-pack-");
try {
  // Keep the populated cache when isolated homes change npm's default cache path.
  const cache = execFileSync("npm", ["config", "get", "cache"], { encoding: "utf8", timeout: 10000 }).trim();
  const npmEnv = { ...process.env, npm_config_cache: cache, npm_config_legacy_peer_deps: "true", npm_config_fetch_retries: "0", npm_config_fetch_timeout: "15000", npm_config_update_notifier: "false" };
  const result = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { encoding: "utf8", env: npmEnv, timeout: 20000 }));
  const packed = Array.isArray(result) ? result[0] : Object.values(result)[0];
  const files = packed.files.map((file) => file.path);
  for (const required of ["dist/index.js", "dist/cli.js", "options.schema.json", "templates/jira.md", "templates/account.example.jsonc"]) assert(files.includes(required));
  assert(!files.some((file) => file.startsWith("test/") || file.startsWith("reports/") || /\.token$|\.tgz$|\.issuekeeper\//.test(file)));
  await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const archive = join(directory, packed.filename);
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive], { cwd: directory, stdio: "pipe", env: npmEnv, timeout: 30000 });
  const installed = join(directory, "node_modules/@issuekeeper/opencode-jira");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert(!manifest.scripts.postinstall && !manifest.scripts.install);
  assert((await readFile(join(installed, "dist/cli.js"), "utf8")).startsWith("#!/usr/bin/env node"));
  assert.equal(await realpath(join(directory, "node_modules/.bin/issuekeeper-jira")), join(installed, "dist/cli.js"));
  const sdk = JSON.parse(await readFile(join(directory, "node_modules/@opencode/plugin/package.json"), "utf8"));
  const uiPeers = ["@opencode/theme", "@opentui/core", "@opentui/solid", "electron", "solid-js", "vite", "vite-plugin-solid"];
  for (const peer of uiPeers) {
    assert.equal(sdk.peerDependenciesMeta[peer].optional, true);
    assert(!existsSync(join(directory, "node_modules", peer, "package.json")));
  }
  const { default: plugin } = await import(pathToFileURL(join(installed, manifest.exports["."])).href);
  assert.equal(plugin.id, "issuekeeper.jira");
  const tools = [];
  const cleanup = await plugin.setup({
    location: { directory },
    options: { accounts: [] },
    tool: { transform: async (callback) => callback({ namespace() {}, add(tool) { tools.push(tool); } }) },
    permission: { assert: async () => { throw new Error("No execution expected during plugin setup"); } },
  });
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "accounts_list", "attachment_download", "attachments_list", "comments_list", "connection_test", "issue_get", "issues_search", "mention_candidates",
  ]);
  assert(!tools.some((tool) => /prepare|apply|upload|transition/.test(tool.name)));
  await cleanup?.();
  const { install, check, uninstall } = await import(pathToFileURL(join(installed, "dist/installer/index.js")).href);
  const { installerPaths } = await import(pathToFileURL(join(installed, "dist/installer/paths.js")).href);
  const io = { accept: async () => true, print() {} };
  globalThis.fetch = async () => { throw new Error("Jira network is prohibited during installation"); };
  for (const source of [variant === "local" ? "local" : archive]) {
    const home = join(directory, source === "local" ? "local home" : "tarball home");
    const env = { ...npmEnv, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data") };
    const paths = installerPaths(env);
    await install(source, io, { paths });
    assert.equal(await check(io, paths), 0);
    const configPath = join(paths.config, "opencode.jsonc");
    const before = await readFile(configPath, "utf8");
    const copy = JSON.parse(before).plugins[0].package;
    for (const peer of uiPeers) assert(!existsSync(join(copy, "..", "..", peer, "package.json")));
    await install(source, io, { paths });
    assert.equal(await readFile(configPath, "utf8"), before);
    const resolution = source === "local" ? ["--no"] : ["--yes", `--package=${archive}`];
    const output = execFileSync("npm", ["exec", "--offline", ...resolution, "--", "issuekeeper-jira", "check", "--global"], { env, cwd: directory, encoding: "utf8", timeout: 40000 });
    assert(output.includes("No comprueba conectividad"));
    await uninstall(io, paths);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).plugins, []);
  }
  console.log(`Smoke ${variant}: instalación, npm exec, check, reinstalación y retirada correctos.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
