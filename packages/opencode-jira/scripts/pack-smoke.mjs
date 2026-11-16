import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const directory = await mkdtemp("/tmp/opencode/issuekeeper-pack-");
try {
  const result = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { encoding: "utf8" }));
  const packed = Array.isArray(result) ? result[0] : Object.values(result)[0];
  const files = packed.files.map((file) => file.path);
  for (const required of ["dist/index.js", "dist/cli.js", "options.schema.json", "templates/jira.md", "templates/account.example.jsonc"]) assert(files.includes(required));
  assert(!files.some((file) => file.startsWith("test/") || file.startsWith("reports/") || /\.token$|\.tgz$|\.issuekeeper\//.test(file)));
  await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const archive = join(directory, packed.filename);
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive], { cwd: directory, stdio: "pipe" });
  const installed = join(directory, "node_modules/@issuekeeper/opencode-jira");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert(!manifest.scripts.postinstall && !manifest.scripts.install);
  assert((await readFile(join(installed, "dist/cli.js"), "utf8")).startsWith("#!/usr/bin/env node"));
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
  for (const source of [archive, "local"]) {
    const home = join(directory, source === "local" ? "local home" : "tarball home");
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data") };
    const paths = installerPaths(env);
    await install(source, io, { paths });
    assert.equal(await check(io, paths), 0);
    const configPath = join(paths.config, "opencode.jsonc");
    const before = await readFile(configPath, "utf8");
    await install(source, io, { paths });
    assert.equal(await readFile(configPath, "utf8"), before);
    const output = execFileSync("npm", ["exec", "--offline", "--yes", `--package=${archive}`, "--", "issuekeeper-jira", "check", "--global"], { env, cwd: directory, encoding: "utf8" });
    assert(output.includes("No comprueba conectividad"));
    await uninstall(io, paths);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).plugins, []);
  }
  console.log("Tarball aislado: ocho herramientas, base sin cuentas, CLI local/tgz, check y retirada comprobados.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
