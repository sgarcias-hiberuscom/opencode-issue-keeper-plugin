import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { check, install, type InstallerIO } from "../../src/installer/index.js";
import { installerPaths, type InstallerPaths } from "../../src/installer/paths.js";
import { startRegistryServer } from "../fixtures/registry-server.mjs";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const exec = promisify(execFile);
const own = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
let scratch: string;
let tarballPath: string;
let home: string;
let paths: InstallerPaths;
let io: InstallerIO;
const plans: string[] = [];

beforeAll(async () => {
  scratch = await mkdtemp("/tmp/opencode/ik-registry-fixture-");
  tarballPath = await buildPackageTarball();
}, 240_000);
afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });
beforeEach(async () => {
  plans.length = 0;
  home = await mkdtemp("/tmp/opencode/ik-registry-");
  paths = installerPaths({ HOME: home, XDG_CONFIG_HOME: join(home, "config with spaces"), XDG_DATA_HOME: join(home, "data with spaces") });
  io = { accept: async (plan) => { plans.push(plan); return true; }, print: vi.fn() };
  const npmrc = join(home, "npmrc");
  await writeFile(npmrc, "registry=https://registry.npmjs.org/\n");
  vi.stubEnv("npm_config_userconfig", npmrc);
  vi.stubEnv("npm_config_cache", join(home, "npm-cache"));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

async function buildPackageTarball(): Promise<string> {
  const root = join(scratch, "package");
  for (const directory of ["dist", "templates", join("templates", "commands")]) await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: own.name, version: own.version, private: true, type: "module",
    exports: { ".": "./dist/index.js" }, bin: { "issuekeeper-jira": "./dist/cli.js" },
    issuekeeperState: own.issuekeeperState, dependencies: own.dependencies,
  }));
  await writeFile(join(root, "dist", "cli.js"), "#!/usr/bin/env node\n");
  for (const file of ["dist/index.js", "dist/uploads.js", "dist/core/proposals.js", "dist/core/review.js", "dist/core/markdown.js", "dist/core/comment.js", "dist/core/adf-document.js", "dist/core/metadata.js", "dist/core/change-policy.js", "dist/state/store.js", "dist/state/coordinator.js", "dist/state/files.js", "dist/state/paths.js", "dist/state/errors.js", "dist/state/application.js", "dist/state/runtime.js", "dist/state/staging.js", "dist/state/multipart.js", "dist/state/review.js", "dist/state/operator.js", "dist/jira/changes.js", "dist/jira/mutations.js", "dist/jira/audience.js", "dist/jira/preparation.js", "dist/jira/attachment-links.js", "dist/tools/changes.js", "dist/tools/shared.js", "dist/tools/change-schemas.js", "dist/tools/change-permissions.js"]) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), "export {};\n");
  }
  await cp(new URL("../../templates/", import.meta.url), join(root, "templates"), { recursive: true });
  await writeFile(join(root, "options.schema.json"), "{}\n");
  for (const name of ["README.md", "opencode.example.jsonc"]) await cp(new URL(`../../${name}`, import.meta.url), join(root, name));
  const archive = join(scratch, "fixture.tgz");
  await exec("tar", ["-czf", archive, "-C", scratch, "package"]);
  return archive;
}

const configPath = () => join(paths.config, "opencode.jsonc");
async function writeConfig(text: string) {
  await mkdir(paths.config, { recursive: true, mode: 0o700 });
  await writeFile(configPath(), text);
}
async function withServer(options: Parameters<typeof startRegistryServer>[1], run: (url: string) => Promise<void>) {
  const server = await startRegistryServer(tarballPath, options);
  vi.stubEnv("ISSUEKEEPER_REGISTRY", server.url);
  try { await run(server.url); } finally { await server.close(); }
}

describe("[6.9][registry] global installation from a registry", () => {
  it("installs the exact CLI version of the running CLI", async () => {
    await withServer({}, async () => {
      await install("registry", io, { paths });
    });
    const printed = [...plans, ...vi.mocked(io.print).mock.calls.map(([message]) => message)].join("\n");
    expect(printed).toContain(`Origen: registro (${own.version})`);
    const config = JSON.parse(await readFile(configPath(), "utf8"));
    expect(config.plugins[0].package).toContain(`/copies/`);
    expect(config.plugins[0].package).toContain("node_modules/@issuekeeper/opencode-jira");
    const installed = config.plugins[0].package as string;
    expect(JSON.parse(await readFile(join(installed, "package.json"), "utf8")).version).toBe(own.version);
    const manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
    expect(manifest.progress).toBe("complete");
    expect(manifest.version).toBe(own.version);
    expect(await check(io, paths)).toBe(0);
  });

  it("rejects a missing version without changing the configuration", async () => {
    const text = '{\n  "model": "custom/model"\n}\n';
    await writeConfig(text);
    await withServer({ missing: true }, async () => {
      await expect(install("registry", io, { paths })).rejects.toThrow("Versión no encontrada en el registro.");
    });
    expect(await readFile(configPath(), "utf8")).toBe(text);
    expect(await readdir(join(paths.data, "copies")).catch(() => [])).toEqual([]);
  });

  it("rejects when the registry integrity does not match", async () => {
    await withServer({ wrongIntegrity: true }, async () => {
      await expect(install("registry", io, { paths })).rejects.toThrow("Integridad del paquete no coincide.");
    });
    expect(await readdir(join(paths.data, "copies")).catch(() => [])).toEqual([]);
    expect(await readdir(paths.config).catch(() => [])).toEqual([]);
  });

  it("rejects another package name", async () => {
    await withServer({ otherName: true }, async () => {
      await expect(install("registry", io, { paths })).rejects.toThrow("El registro devolvió un paquete distinto.");
    });
    expect(await readdir(join(paths.data, "copies")).catch(() => [])).toEqual([]);
  });

  it("fails cleanly when the registry is unreachable", async () => {
    const dead = await startRegistryServer(tarballPath);
    const url = dead.url;
    await dead.close();
    vi.stubEnv("ISSUEKEEPER_REGISTRY", url);
    await expect(install("registry", io, { paths })).rejects.toThrow("Registro no accesible.");
    const leftovers = (await readdir(paths.data)).filter((entry) => entry.startsWith(".prepare-"));
    expect(leftovers).toEqual([]);
  });

  it("never prints npm output or credentials from the npm configuration", async () => {
    const text = '{\n}\n';
    await writeConfig(text);
    const messages: string[] = [];
    const failing = { ...io, print: (message: string) => { messages.push(message); } };
    await withServer({ missing: true }, async (url) => {
      const npmrc = join(home, "npmrc");
      await writeFile(npmrc, `registry=https://registry.npmjs.org/\n//127.0.0.1:${new URL(url).port}/:_authToken=ik-fake-token\n`);
      vi.stubEnv("npm_config_userconfig", npmrc);
      try { await install("registry", failing, { paths }); }
      catch (error) { messages.push(error instanceof Error ? error.message : String(error)); }
    });
    const output = messages.join("\n");
    expect(output).not.toContain("ik-fake-token");
    expect(output).not.toContain("npm error");
    expect(await readFile(configPath(), "utf8")).toBe(text);
  });
});
