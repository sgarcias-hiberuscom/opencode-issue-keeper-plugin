import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { check, install, uninstall, type InstallerIO } from "../../src/installer/index.js";
import { installerPaths, type InstallerPaths } from "../../src/installer/paths.js";
import { atomicWrite, hash } from "../../src/installer/files.js";
import { parseDocument } from "../../src/installer/jsonc.js";
import { parseArguments } from "../../src/cli.js";
import { baseOptions } from "../../src/defaults.js";
import { createRequire } from "node:module";
import { ChangeStore } from "../../src/state/store.js";
import { withChangeStore } from "../../src/state/coordinator.js";
import { statePaths } from "../../src/state/paths.js";
import { planFixture, instant } from "../state-fixtures.js";
import Database from "better-sqlite3";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { m3Fixture } from "../m3-fixtures.js";

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
  await writeFile(join(installed, "dist/uploads.js"), "export {};");
  for (const name of ["core/proposals", "core/review", "core/markdown", "core/comment", "core/adf-document", "core/metadata", "core/change-policy", "state/store", "state/coordinator", "state/files", "state/paths", "state/errors", "state/application", "state/runtime", "state/staging", "state/multipart", "state/review", "state/operator", "jira/changes", "jira/mutations", "jira/audience", "jira/preparation", "jira/attachment-links", "tools/changes", "tools/shared", "tools/change-schemas", "tools/change-permissions"]) {
    await mkdir(join(installed, "dist", name.split("/")[0]!), { recursive: true });
    await writeFile(join(installed, "dist", `${name}.js`), "export {};");
  }
  await writeFile(join(installed, "options.schema.json"), "{}");
  for (const name of ["README.md", "opencode.example.jsonc"]) await cp(new URL(`../../${name}`, import.meta.url), join(installed, name));
  await cp(new URL("../../templates/", import.meta.url), join(installed, "templates"), { recursive: true });
  const release = join(paths.data, "copies", "a".repeat(64));
  const lock: { packages: Record<string, { version: string }> } = { packages: {} };
  lock.packages["node_modules/@issuekeeper/opencode-jira"] = { version: own.version };
  for (const dependency of Object.keys(own.dependencies)) {
    await mkdir(join(release, "node_modules", dependency), { recursive: true });
    const version = own.dependencies[dependency];
    lock.packages[`node_modules/${dependency}`] = { version };
    await writeFile(join(release, "node_modules", dependency, "package.json"), JSON.stringify({ name: dependency, version }));
    if (dependency === "better-sqlite3") {
      const actual = createRequire(import.meta.url).resolve("better-sqlite3");
      await writeFile(join(release, "node_modules", dependency, "index.js"), `module.exports = require(${JSON.stringify(actual)});`);
    }
  }
  await writeFile(join(release, "package-lock.json"), JSON.stringify(lock));
  prepare = vi.fn(async () => ({ installed, version: own.version }));
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); vi.restoreAllMocks(); });
const configPath = () => join(paths.config, "opencode.jsonc");
async function writeConfig(text: string, name = "opencode.jsonc") {
  await mkdir(paths.config, { recursive: true, mode: 0o700 });
  await writeFile(join(paths.config, name), text);
}
async function runInstall() { return install("local", io, { paths, prepare }); }
async function candidate(version = "0.3.0") {
  const original = await prepare("local", paths.data);
  const release = join(paths.data, "copies", "b".repeat(64));
  await cp(original.installed.slice(0, -"/node_modules/@issuekeeper/opencode-jira".length), release, { recursive: true });
  const installed = join(release, "node_modules/@issuekeeper/opencode-jira");
  const metadata = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  await writeFile(join(installed, "package.json"), JSON.stringify({ ...metadata, version }));
  const lock = JSON.parse(await readFile(join(release, "package-lock.json"), "utf8"));
  lock.packages["node_modules/@issuekeeper/opencode-jira"].version = version;
  await writeFile(join(release, "package-lock.json"), JSON.stringify(lock));
  prepare.mockResolvedValue({ installed, version });
  return { installed, version };
}
async function snapshots() {
  const store = new ChangeStore(paths.data, { mode: "maintenance" });
  try { return { change: store.get("proposal-1"), events: store.events("proposal-1") }; } finally { store.close(); }
}

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
    expect(() => installerPaths({ HOME: home, XDG_DATA_HOME: "../relative" })).toThrow();
  });
});

describe("[INS-01–INS-03][D-13][RC-10] shared maintenance ownership", () => {
  it("initializes a private global database and preserves prepared plans across reinstall and removal", async () => {
    await runInstall();
    const runtime = statePaths(paths.data);
    expect((await stat(runtime.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(runtime.database)).mode & 0o777).toBe(0o600);
    const store = new ChangeStore(paths.data, { now: () => new Date(instant) });
    const prepared = store.prepare(planFixture()); store.close();
    await runInstall();
    await uninstall(io, paths);
    const reopened = new ChangeStore(paths.data);
    try { expect(reopened.get(prepared.plan.id)).toEqual(prepared); } finally { reopened.close(); }
  });
  it("blocks installer admission while a runtime callback owns the store, including during approval", async () => {
    await runInstall();
    await withChangeStore(async () => {
      const before = await readFile(configPath(), "utf8");
      await expect(runInstall()).rejects.toMatchObject({ reason: "BUSY" });
      await expect(uninstall(io, paths)).rejects.toMatchObject({ reason: "BUSY" });
      expect(await readFile(configPath(), "utf8")).toBe(before);
    }, { data: paths.data });
  });
  it("retains maintenance ownership across user confirmation, so a new runtime cannot race the change", async () => {
    io.accept = async () => {
      expect(() => new ChangeStore(paths.data)).toThrow();
      return true;
    };
    await runInstall();
    expect(await check(io, paths)).toBe(0);
  });
  it("blocks replacement/removal after a crash with a possibly sent operation", async () => {
    await runInstall();
    const store = new ChangeStore(paths.data, { now: () => new Date(instant) });
    store.prepare(planFixture()); store.claim("proposal-1", 0); store.sending("proposal-1", 1, "step-1"); store.close();
    const before = await readFile(configPath(), "utf8");
    await expect(runInstall()).rejects.toMatchObject({ reason: "BUSY" });
    await expect(uninstall(io, paths)).rejects.toMatchObject({ reason: "BUSY" });
    expect(await readFile(configPath(), "utf8")).toBe(before);
    expect(await check(io, paths)).toBe(0);
    const inspect = new ChangeStore(paths.data, { mode: "maintenance" });
    try { expect(inspect.get("proposal-1").execution.steps[0]!.state).toBe("sending"); } finally { inspect.close(); }
  });
  it("does not replace corrupt state or treat an incompatible schema as an empty installation", async () => {
    await runInstall();
    const runtime = statePaths(paths.data);
    await writeFile(runtime.database, "corrupt-state");
    await expect(runInstall()).rejects.toMatchObject({ reason: "CORRUPT" });
    expect(await readFile(runtime.database, "utf8")).toBe("corrupt-state");
  });
  it.each(["database", "plan"])("blocks a candidate with incompatible %s metadata before changing managed files", async (format) => {
    await runInstall(); const before = await readFile(configPath(), "utf8");
    const next = await candidate(); const path = join(next.installed, "package.json");
    const metadata = JSON.parse(await readFile(path, "utf8")); metadata.issuekeeperState[format]++;
    await writeFile(path, JSON.stringify(metadata));
    await expect(runInstall()).rejects.toThrow("incompatible");
    expect(await readFile(configPath(), "utf8")).toBe(before);
    expect(await check(io, paths)).toBe(0);
  });
  it.each(["dist/jira/preparation.js", "dist/core/comment.js", "templates/commands/jira-update.md"])("rejects a candidate missing %s", async (file) => {
    await runInstall(); const before = await readFile(configPath(), "utf8");
    const next = await candidate(); await rm(join(next.installed, file));
    await expect(runInstall()).rejects.toThrow("incompleto");
    expect(await readFile(configPath(), "utf8")).toBe(before);
  });
  it.each(["schema", "plan"])("refuses unsupported persisted %s without changing or migrating bytes", async (format) => {
    await runInstall();
    const store = new ChangeStore(paths.data, { now: () => new Date(instant) }); store.prepare(planFixture()); store.close();
    const db = new Database(statePaths(paths.data).database);
    if (format === "schema") db.pragma("user_version=2");
    else db.prepare("UPDATE plans SET document=? WHERE id=?").run(JSON.stringify({ ...planFixture(), version: 2 }), "proposal-1");
    db.close();
    const before = await readFile(statePaths(paths.data).database); const config = await readFile(configPath(), "utf8");
    await expect(runInstall()).rejects.toMatchObject({ reason: "INCOMPATIBLE" });
    await expect(uninstall(io, paths)).rejects.toMatchObject({ reason: "INCOMPATIBLE" });
    expect(await readFile(statePaths(paths.data).database)).toEqual(before);
    expect(await readFile(configPath(), "utf8")).toBe(config);
  });
  it.each(["prepared", "applied", "rejected", "partial", "unknown"])("preserves %s plans, receipts, hashes and audit while allowing only safe maintenance", async (state) => {
    await runInstall(); const store = new ChangeStore(paths.data, { now: () => new Date(instant) });
    const plan = planFixture({ steps: state === "partial" ? [{ id: "step-1", kind: "mutation", fileRefs: [] }, { id: "step-2", kind: "mutation", fileRefs: [] }] : planFixture().steps });
    store.prepare(plan);
    if (state !== "prepared") {
      store.claim(plan.id, 0); store.sending(plan.id, 1, "step-1");
      if (state === "unknown" || state === "rejected") store.stop(plan.id, 2, "step-1", state === "unknown" ? "unknown" : "failed", undefined, state === "rejected" ? 400 : undefined);
      else {
        store.confirm(plan.id, 2, "step-1", { remoteIds: ["remote:1"], temporaryAttachmentIds: [], confirmedAt: instant });
        store.verified(plan.id, 3, "step-1");
        if (state === "partial") store.stop(plan.id, 4, undefined, "failed");
      }
    }
    store.close(); const before = await snapshots(); await candidate();
    if (["partial", "unknown"].includes(state)) {
      await expect(runInstall()).rejects.toMatchObject({ reason: "BUSY" });
      await expect(uninstall(io, paths)).rejects.toMatchObject({ reason: "BUSY" });
    } else { await runInstall(); await uninstall(io, paths); }
    expect(await snapshots()).toEqual(before);
  });
  it("keeps customized instructions, account options and concurrent JSONC edits during an upgrade", async () => {
    await runInstall(); await writeFile(paths.instructions, "custom instructions");
    const config = parseDocument(await readFile(configPath(), "utf8")) as any;
    config.plugins[0].options.accounts = [{ id: "qa", siteUrl: "https://synthetic.atlassian.net", auth: { mode: "cloud-token", email: "synthetic@example.invalid", tokenEnv: "SYNTHETIC_TOKEN" } }];
    await writeConfig(JSON.stringify(config)); const before = await readFile(configPath(), "utf8"); await candidate();
    io.accept = async () => { await writeConfig(`${before}\n// concurrent edit\n`); return true; };
    await expect(runInstall()).rejects.toThrow("concurrente");
    expect(await readFile(configPath(), "utf8")).toBe(`${before}\n// concurrent edit\n`);
    io.accept = async () => true; await runInstall();
    expect((parseDocument(await readFile(configPath(), "utf8")) as any).plugins[0].options.accounts).toEqual(config.plugins[0].options.accounts);
    expect(await readFile(paths.instructions, "utf8")).toBe("custom instructions"); expect(await check(io, paths)).toBe(0);
  });
  it.each(["removing", "prepared", "configured", "instructions"] as const)("resumes account-preserving removal after interruption at %s", async (checkpoint) => {
    await runInstall(); const config = parseDocument(await readFile(configPath(), "utf8")) as any;
    config.plugins[0].options.accounts = [{ id: "qa", siteUrl: "https://synthetic.atlassian.net", auth: { mode: "cloud-token", email: "synthetic@example.invalid", tokenEnv: "SYNTHETIC_TOKEN" } }];
    await writeConfig(JSON.stringify(config));
    await expect(uninstall(io, paths, { afterStep: async (step) => { if (step === checkpoint) throw new Error("interruption"); } })).rejects.toThrow("interruption");
    expect(await check(io, paths)).toBe(1); await expect(runInstall()).rejects.toThrow("Retirada interrumpida");
    await uninstall(io, paths); const exported = join(paths.data, "preserved-options.json");
    expect(JSON.parse(await readFile(exported, "utf8")).options.accounts).toEqual(config.plugins[0].options.accounts);
    expect((await stat(exported)).mode & 0o777).toBe(0o600);
    expect(parseDocument(await readFile(configPath(), "utf8")).plugins).toEqual([]);
  });
  it.each([
    ["install", "prepared"], ["install", "instructions"], ["install", "configured"],
    ["uninstall", "removing"], ["uninstall", "prepared"], ["uninstall", "configured"], ["uninstall", "instructions"],
  ])("recovers %s after SIGKILL at %s with the approved plan intact", async (action, checkpoint) => {
    await runInstall();
    const config = parseDocument(await readFile(configPath(), "utf8")) as any;
    config.plugins[0].options.accounts = [{ id: "qa", siteUrl: "https://synthetic.atlassian.net", auth: { mode: "cloud-token", email: "synthetic@example.invalid", tokenEnv: "SYNTHETIC_TOKEN" } }];
    await writeConfig(JSON.stringify(config));
    const store = new ChangeStore(paths.data, { now: () => new Date(instant) }); store.prepare(planFixture()); store.close();
    const before = await snapshots(); const next = await candidate();
    const template = `${await readFile(join(next.installed, "templates/jira.md"), "utf8")}\nVersioned synthetic instructions.\n`;
    await writeFile(join(next.installed, "templates/jira.md"), template);
    const child = fork(fileURLToPath(new URL("../fixtures/installer-worker.mjs", import.meta.url)), [home, checkpoint, next.installed, next.version, action], {
      execArgv: ["--experimental-transform-types", "--experimental-loader", fileURLToPath(new URL("../fixtures/state-loader.mjs", import.meta.url))],
      env: {}, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    try {
      const reached = new Promise((resolve, reject) => {
        let stderr = ""; child.stderr!.on("data", (value) => { stderr += String(value); });
        child.once("error", reject); child.once("exit", () => reject(new Error(`Worker exited before checkpoint: ${stderr}`))); child.once("message", resolve);
      });
      expect(await reached).toEqual({ checkpoint });
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      expect(await check(io, paths)).toBe(1);
      if (action === "install") {
        await runInstall(); expect(await check(io, paths)).toBe(0);
        expect((parseDocument(await readFile(configPath(), "utf8")) as any).plugins[0].package).toBe(next.installed);
        expect(await readFile(paths.instructions, "utf8")).toBe(template);
      } else {
        await uninstall(io, paths);
        expect(parseDocument(await readFile(configPath(), "utf8")).plugins).toEqual([]);
        expect(JSON.parse(await readFile(join(paths.data, "preserved-options.json"), "utf8")).options.accounts).toEqual(config.plugins[0].options.accounts);
      }
      expect(await snapshots()).toEqual(before);
    } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } }
  }, 20000);
  it.each(["approval", "sending", "cleanup"])("blocks replacement and removal during the integrated engine's %s window", async (window) => {
    await runInstall(); vi.stubEnv("IK_TEST_WORK", "synthetic-token");
    const f = await m3Fixture(false, paths.data);
    let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; });
    let task: Promise<unknown> | undefined;
    try {
      const plan = await f.prepare("comment_prepare", { audience: "ticket", text: "synthetic maintenance" });
      const before = await readFile(configPath(), "utf8");
      if (window === "approval") f.harness.assert.mockImplementation(async (request: unknown) => { if ((request as { action: string }).action === "jira.write") { entered(); await wait; } });
      else {
        const original = f.fetcher.getMockImplementation()!;
        f.fetcher.mockImplementation(async (url, init) => { if (init?.method === "POST") { entered(); await wait; } return original(url, init); });
      }
      task = f.harness.invoke("change_apply", { proposalId: plan.id });
      const settled = task.then(() => undefined, () => undefined);
      await ready;
      const closing = window === "cleanup" ? f.harness.close() : undefined;
      await expect(runInstall()).rejects.toMatchObject({ reason: "BUSY" });
      await expect(uninstall(io, paths)).rejects.toMatchObject({ reason: "BUSY" });
      expect(await readFile(configPath(), "utf8")).toBe(before);
      release(); await settled; await closing;
      if (window === "cleanup") {
        const saved = await f.saved(plan); expect(saved.execution.state).toBe("unknown");
        await expect(runInstall()).rejects.toMatchObject({ reason: "BUSY" });
      } else {
        expect((await f.saved(plan)).execution.state).toBe("applied");
        expect(f.ledger).toHaveLength(1); await runInstall();
      }
    } finally { release(); await task?.catch(() => {}); await f.close(); await rm(f.root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
  }, 20000);
});
