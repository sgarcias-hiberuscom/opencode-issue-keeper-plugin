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
  assert(files.includes("dist/index.js"));
  assert(files.includes("options.schema.json"));
  assert(!files.some((file) => file.startsWith("test/") || /\.token$|\.tgz$|\.issuekeeper\//.test(file)));
  await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(directory, packed.filename)], { cwd: directory, stdio: "pipe" });
  const installed = join(directory, "node_modules/@issuekeeper/opencode-jira");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  const { default: plugin } = await import(pathToFileURL(join(installed, manifest.exports["."])).href);
  assert.equal(plugin.id, "issuekeeper.jira");
  const tools = [];
  const cleanup = await plugin.setup({
    location: { directory },
    options: { accounts: [{ id: "test", siteUrl: "https://example.atlassian.net", auth: { mode: "cloud-token", email: "test@example.com", tokenEnv: "ISSUEKEEPER_PACK_NO_TOKEN" }, allowedProjects: ["IK"] }] },
    tool: { transform: async (callback) => callback({ namespace() {}, add(tool) { tools.push(tool); } }) },
    permission: { assert: async () => { throw new Error("No execution expected during plugin setup"); } },
  });
  assert.equal(tools.length, 7);
  assert(!tools.some((tool) => /prepare|apply|upload|transition/.test(tool.name)));
  await cleanup?.();
  console.log("Tarball instalado y contrato V2 cargado: 7 herramientas de lectura/descarga.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
