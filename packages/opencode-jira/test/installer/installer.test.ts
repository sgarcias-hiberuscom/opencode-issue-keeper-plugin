import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { check, install, uninstall, type InstallerIO } from "../../src/installer/index.js";
import { installerPaths, type InstallerPaths } from "../../src/installer/paths.js";
import { atomicWrite, hash } from "../../src/installer/files.js";
import { parseDocument } from "../../src/installer/jsonc.js";
import { parseArguments } from "../../src/cli.js";
import { baseOptions } from "../../src/defaults.js";

let home: string;
let paths: InstallerPaths;
let io: InstallerIO;
let prepare: ReturnType<typeof vi.fn<(source: string, data: string) => Promise<{ installed: string; version: string }>>>;
beforeEach(async () => {
  home = await mkdtemp("/tmp/opencode/ik installer ");
  paths = installerPaths({ HOME: home, XDG_CONFIG_HOME: join(home, "config with spaces"), XDG_DATA_HOME: join(home, "data with spaces") });
  io = { accept: vi.fn(async () => true), print: vi.fn() };
  const installed = join(paths.data, "copies", "a".repeat(64), "node_modules/@issuekeeper/opencode-jira");
  await mkdir(installed, { recursive: true, mode: 0o700 });
  for (const name of ["templates", "dist"]) await mkdir(join(installed, name));
  const own = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  await writeFile(join(installed, "package.json"), JSON.stringify(own));
  await writeFile(join(installed, "dist/index.js"), "export default {};");
  await writeFile(join(installed, "dist/cli.js"), "#!/usr/bin/env node\n");
  await writeFile(join(installed, "options.schema.json"), "{}");
  await cp(new URL("../../templates/", import.meta.url), join(installed, "templates"), { recursive: true });
  const release = join(paths.data, "copies", "a".repeat(64));
  const lock: { packages: Record<string, { version: string }> } = { packages: {} };
  lock.packages["node_modules/@issuekeeper/opencode-jira"] = { version: own.version };
  for (const dependency of ["@opencode/plugin", "zod", "jsonc-parser"]) {
    await mkdir(join(release, "node_modules", dependency), { recursive: true });
    const version = own.dependencies[dependency];
    lock.packages[`node_modules/${dependency}`] = { version };
    await writeFile(join(release, "node_modules", dependency, "package.json"), JSON.stringify({ name: dependency, version }));
  }
  await writeFile(join(release, "package-lock.json"), JSON.stringify(lock));
  prepare = vi.fn(async () => ({ installed, version: "0.1.0" }));
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); vi.restoreAllMocks(); });
const configPath = () => join(paths.config, "opencode.jsonc");
async function writeConfig(text: string, name = "opencode.jsonc") {
  await mkdir(paths.config, { recursive: true, mode: 0o700 });
  await writeFile(join(paths.config, name), text);
}
async function runInstall() { return install("local", io, { paths, prepare }); }

describe("[6.9][E00][IN-02] isolated global installer", () => {
  it("installs the exact empty base, keeps a private manifest and is idempotent", async () => {
    await runInstall();
    const text = await readFile(configPath(), "utf8");
    const config = parseDocument(text) as any;
    expect(config.plugins[0].options).toEqual(baseOptions());
    expect(config.instructions).toEqual([paths.instructions]);
    expect(config.instructions).not.toContain(paths.example);
    expect(await check(io, paths)).toBe(0);
    const manifest = await readFile(paths.manifest, "utf8");
    for (const forbidden of ['"email"', '"tokenFile"', '"tokenEnv"', '"accounts"']) expect(manifest).not.toContain(forbidden);
    expect((await stat(paths.manifest)).mode & 0o077).toBe(0);
    const before = (await stat(configPath())).mtimeMs;
    await runInstall();
    expect(await readFile(configPath(), "utf8")).toBe(text);
    expect((await stat(configPath())).mtimeMs).toBe(before);
    expect(await readFile(paths.manifest, "utf8")).toBe(manifest);
  });
  it.each(["opencode.json", "opencode.jsonc"])("preserves comments, unrelated text and deny order in %s", async (name) => {
    const unrelated = '// preserve this exactly\n  "model": "custom/model",';
    const rules = [{ action: "jira.read", resource: "*", effect: "deny" }, { action: "shell", resource: "*", effect: "ask" }];
    await writeConfig(`{\n  ${unrelated}\n  "permissions": ${JSON.stringify(rules)}\n}\n`, name);
    await runInstall();
    const text = await readFile(join(paths.config, name), "utf8");
    expect(text).toContain(unrelated);
    expect((parseDocument(text).permissions as unknown[]).slice(0, 2)).toEqual(rules);
    expect((parseDocument(text).permissions as any[]).filter((r) => r.action === "jira.read")).toEqual([rules[0]]);
    const backups = await readdir(join(paths.data, "backups"));
    expect((await stat(join(paths.data, "backups", backups[0]!))).mode & 0o077).toBe(0);
  });
  it.each(['{"plugins": [}', '{"model": 1, "model": 2}', '{"x":{"y":1,"y":2}}'])("refuses malformed or duplicate JSONC before preparation", async (text) => {
    await writeConfig(text);
    await expect(runInstall()).rejects.toThrow();
    expect(prepare).not.toHaveBeenCalled();
    expect(await readFile(configPath(), "utf8")).toBe(text);
  });
  it("refuses ambiguous config files and references loaded by another path", async () => {
    await writeConfig("{}"); await writeConfig("{}", "opencode.json");
    await expect(runInstall()).rejects.toThrow("Existen");
    await rm(join(paths.config, "opencode.json"));
    await writeConfig('{"plugins": ["@issuekeeper/opencode-jira"]}');
    await expect(runInstall()).rejects.toThrow("otra referencia");
  });
  it("does not approve conflicts or publish anything without explicit acceptance", async () => {
    io.accept = async () => false;
    await expect(runInstall()).rejects.toThrow("no aceptado");
    expect(await readdir(paths.config).catch(() => [])).toEqual([]);
    expect(await readFile(paths.manifest, "utf8").catch(() => undefined)).toBeUndefined();
  });
  it("recognizes a prior instructions glob and does not duplicate it", async () => {
    const glob = join(paths.config, "instructions/*.md");
    await writeConfig(JSON.stringify({ instructions: [glob] }));
    await runInstall();
    expect(parseDocument(await readFile(configPath(), "utf8")).instructions).toEqual([glob]);
    expect(await check(io, paths)).toBe(0);
    await uninstall(io, paths);
    expect(parseDocument(await readFile(configPath(), "utf8")).instructions).toEqual([glob]);
    expect(await readFile(paths.instructions, "utf8")).toContain("# Uso de Jira");
  });
  it("keeps an intact template that still has a pre-existing absolute reference", async () => {
    await writeConfig(JSON.stringify({ instructions: [paths.instructions] }));
    await runInstall();
    await uninstall(io, paths);
    expect(parseDocument(await readFile(configPath(), "utf8")).instructions).toEqual([paths.instructions]);
    expect(await readFile(paths.instructions, "utf8")).toContain("# Uso de Jira");
  });
  it("preserves foreign jira.md without registration or overwrite", async () => {
    await mkdir(join(paths.config, "instructions"), { recursive: true, mode: 0o700 });
    await writeFile(paths.instructions, "foreign");
    await expect(runInstall()).rejects.toThrow("desconocido");
    expect(await readFile(paths.instructions, "utf8")).toBe("foreign");
    expect(await readFile(configPath(), "utf8").catch(() => undefined)).toBeUndefined();
  });
  it("conserves customized instructions and emits a non-overwriting comparison", async () => {
    await runInstall(); await writeFile(paths.instructions, "custom");
    await runInstall();
    expect(await readFile(paths.instructions, "utf8")).toBe("custom");
    const comparisons = (await readdir(join(paths.config, "instructions"))).filter((name) => name.startsWith("jira.md.new-"));
    expect(comparisons).toHaveLength(1);
    await writeFile(join(paths.config, "instructions", comparisons[0]!), "custom comparison");
    await expect(runInstall()).rejects.toThrow("comparación");
    expect(await readFile(join(paths.config, "instructions", comparisons[0]!), "utf8")).toBe("custom comparison");
  });
  it("requires separate explicit restoration of a removed instruction", async () => {
    await runInstall(); await rm(paths.instructions);
    io.accept = vi.fn(async () => false);
    await expect(runInstall()).rejects.toThrow("Restauración");
    expect(io.accept).toHaveBeenCalledWith(expect.stringContaining("Restaurar explícitamente"));
  });
  it("detects concurrent edits and does not publish over them", async () => {
    await writeConfig("{}");
    io.accept = async () => { await writeConfig('{"model":"user-edit"}'); return true; };
    await expect(runInstall()).rejects.toThrow("concurrente");
    expect(await readFile(configPath(), "utf8")).toBe('{"model":"user-edit"}');
    expect(await readdir(join(paths.config, "instructions")).catch(() => [])).toEqual([]);
  });
  it("keeps active files unchanged on preparation failure", async () => {
    await runInstall();
    const before = await readFile(configPath(), "utf8");
    prepare.mockRejectedValue(new Error("npm failure"));
    await expect(runInstall()).rejects.toThrow();
    expect(await readFile(configPath(), "utf8")).toBe(before);
    expect(await check(io, paths)).toBe(0);
  });
  it.each(["prepared", "instructions", "configured"] as const)("resumes safely after interruption at %s", async (step) => {
    await expect(install("local", io, { paths, prepare, afterStep: async (current) => {
      if (current === step) throw new Error("simulated interruption");
    } })).rejects.toThrow("interruption");
    expect(await check(io, paths)).toBe(1);
    await runInstall();
    expect(await check(io, paths)).toBe(0);
    const config = parseDocument(await readFile(configPath(), "utf8")) as any;
    expect(config.plugins).toHaveLength(1);
    expect(config.instructions).toEqual([paths.instructions]);
  });
  it("rejects symlinks before following them", async () => {
    await writeConfig("{}"); const decoy = join(home, "decoy");
    await writeFile(decoy, "untouched");
    await rm(configPath()); await symlink(decoy, configPath());
    await expect(runInstall()).rejects.toThrow("simbólicos");
    expect(await readFile(decoy, "utf8")).toBe("untouched");
  });
  it("check is read-only and detects missing instructions, dist and incomplete progress", async () => {
    await runInstall();
    const configBefore = await readFile(configPath(), "utf8");
    const manifestBefore = await readFile(paths.manifest, "utf8");
    expect(await check(io, paths)).toBe(0);
    expect(await readFile(paths.manifest, "utf8")).toBe(manifestBefore);
    expect(await readFile(configPath(), "utf8")).toBe(configBefore);
    await rm(paths.instructions); expect(await check(io, paths)).toBe(1);
    const m = JSON.parse(manifestBefore);
    await writeFile(paths.manifest, JSON.stringify({ ...m, progress: "prepared" }));
    expect(await check(io, paths)).toBe(1);
    await writeFile(paths.manifest, manifestBefore);
    await rm(join(m.installed, "dist/index.js"));
    expect(await check(io, paths)).toBe(1);
  });
  it("uninstalls only owned references and intact templates, keeping custom files and sentinels", async () => {
    await runInstall(); await writeFile(paths.instructions, "custom");
    const sentinel = join(paths.config, "keep"); await writeFile(sentinel, "keep");
    await uninstall(io, paths);
    const config = parseDocument(await readFile(configPath(), "utf8"));
    expect(config.plugins).toEqual([]);
    expect(config.instructions).toEqual([]);
    expect(await readFile(paths.instructions, "utf8")).toBe("custom");
    expect(await readFile(sentinel, "utf8")).toBe("keep");
    expect(await readFile(paths.example, "utf8").catch(() => undefined)).toBeUndefined();
    expect(config.permissions).toBeDefined();
    await uninstall(io, paths);
  });
  it("exports configured accounts privately, without putting profiles in the manifest", async () => {
    await runInstall();
    const config = parseDocument(await readFile(configPath(), "utf8")) as any;
    config.plugins[0].options.accounts = [{ id: "work", siteUrl: "https://example.atlassian.net", auth: { mode: "cloud-token", email: "work@example.com", tokenEnv: "PRIVATE" } }];
    await writeConfig(JSON.stringify(config));
    await runInstall();
    expect((parseDocument(await readFile(configPath(), "utf8")) as any).plugins[0].options.accounts).toEqual(config.plugins[0].options.accounts);
    await uninstall(io, paths);
    const file = join(paths.data, "preserved-options.json");
    expect((await stat(file)).mode & 0o077).toBe(0);
    expect(await readFile(file, "utf8")).toContain("PRIVATE");
    expect(await readFile(paths.manifest, "utf8")).not.toContain("PRIVATE");
  });
});

describe("[6.9][E00][IN-01] CLI arguments and filesystem primitives", () => {
  it.each([[], ["install"], ["check"], ["check", "--global", "--unknown"],
    ["install", "--global"], ["install", "--global", "--source"], ["install", "--global", "--source", "--global"],
    ["install", "--global", "--global", "--source", "local"], ["uninstall", "--global", "--source", "local"],
  ].map((args) => [args]))("rejects invalid argv without effects (%#)", (args) => { expect(() => parseArguments(args)).toThrow(); });
  it("rejects concurrent replacement without modifying the destination", async () => {
    const file = join(home, "file"); await writeFile(file, "newer");
    await expect(atomicWrite(file, "overwrite", "older")).rejects.toThrow("cambió");
    expect(await readFile(file, "utf8")).toBe("newer");
  });
  it("resolves HOME/XDG independent of cwd", () => {
    expect(paths.config).toBe(join(home, "config with spaces/opencode"));
    expect(() => installerPaths({ HOME: home, XDG_CONFIG_HOME: "../relative" })).toThrow();
  });
});
