// Campaña 10.6: sólo los puntos sin cobertura en installer.test.ts ni registry.test.ts
// (ver doc/desglose-tareas-fase-3.md, T12, y reports/release/T12-resultado.md).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { check, install, uninstall, type InstallerIO } from "../../src/installer/index.js";
import { installerPaths, type InstallerPaths } from "../../src/installer/paths.js";
import { parseDocument } from "../../src/installer/jsonc.js";
import { createRequire } from "node:module";

// Punto s) disco lleno: ENOSPC inyectado en la escritura objetivo, sin llenar el disco.
const faults = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock("../../src/installer/files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/installer/files.js")>();
  return {
    ...actual,
    atomicWrite: async (...args: Parameters<typeof actual.atomicWrite>) => {
      if (faults.path !== undefined && args[0] === faults.path) {
        faults.path = undefined;
        throw Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" });
      }
      return actual.atomicWrite(...args);
    },
  };
});

let home: string;
let paths: InstallerPaths;
let io: InstallerIO;
let prepare: ReturnType<typeof vi.fn<(source: string, data: string) => Promise<{ installed: string; version: string }>>>;
beforeEach(async () => {
  home = await mkdtemp("/tmp/opencode/ik campaign ");
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
const printed = () => vi.mocked(io.print).mock.calls.map(([message]) => message).join("\n");

describe("[6.9][10.6] installer campaign, uncovered points", () => {
  it("blocks a Jira plugin discovered by another mechanism (plugins/ directory) and accepts unrelated ones (k)", async () => {
    await writeConfig("{}");
    await mkdir(join(paths.config, "plugins"), { recursive: true, mode: 0o700 });
    await writeFile(join(paths.config, "plugins", "my-jira-bridge.js"), "export default {};");
    await expect(runInstall()).rejects.toThrow("descubierto automáticamente");
    expect(prepare).not.toHaveBeenCalled();
    expect(await readFile(configPath(), "utf8")).toBe("{}");
    expect(await readFile(paths.manifest, "utf8").catch(() => undefined)).toBeUndefined();
    await rm(join(paths.config, "plugins", "my-jira-bridge.js"));
    await writeFile(join(paths.config, "plugins", "unrelated-helper.js"), "export default {};");
    await runInstall();
    expect(await check(io, paths)).toBe(0);
    expect(await readFile(join(paths.config, "plugins", "unrelated-helper.js"), "utf8")).toBe("export default {};");
    await uninstall(io, paths);
  });
  it("refuses duplicated managed references before preparation (j: referencia duplicada)", async () => {
    await writeConfig('{"plugins": [{"package": "@issuekeeper/opencode-jira"}, {"package": "@issuekeeper/opencode-jira"}]}');
    await expect(runInstall()).rejects.toThrow("Hay varias referencias a Jira");
    expect(prepare).not.toHaveBeenCalled();
    expect(await readFile(configPath(), "utf8")).toBe('{"plugins": [{"package": "@issuekeeper/opencode-jira"}, {"package": "@issuekeeper/opencode-jira"}]}');
    expect(await readFile(paths.manifest, "utf8").catch(() => undefined)).toBeUndefined();
  });
  it("refuses incompatible permission rules without modifying them (n: reglas ajenas o inválidas)", async () => {
    const rules = [{ action: "jira.write", resource: "*", effect: "deny" }, { action: "jira.write", resource: "*", effect: "forbid" }];
    await writeConfig(`{"permissions": ${JSON.stringify(rules)}}`);
    await expect(runInstall()).rejects.toThrow("Reglas de permisos incompatibles");
    expect(JSON.parse(await readFile(configPath(), "utf8")).permissions).toEqual(rules);
    expect(await readFile(paths.manifest, "utf8").catch(() => undefined)).toBeUndefined();
  });
  it("applies a new distributed template over an intact jira.md without duplicates or comparison copies (p)", async () => {
    await runInstall();
    const next = await candidate("0.4.0");
    const updated = `${await readFile(join(next.installed, "templates/jira.md"), "utf8")}\nSynthetic new distributed template.\n`;
    await writeFile(join(next.installed, "templates/jira.md"), updated);
    await runInstall();
    expect(await readFile(paths.instructions, "utf8")).toBe(updated);
    const config = parseDocument(await readFile(configPath(), "utf8")) as any;
    expect(config.instructions).toEqual([paths.instructions]);
    expect(config.plugins[0].package).toBe(next.installed);
    expect((await readdir(join(paths.config, "instructions"))).filter((name) => name.startsWith("jira.md.new-"))).toEqual([]);
    expect(await check(io, paths)).toBe(0);
  });
  it("stops on injected ENOSPC during the configuration write, keeps the incomplete journal and resumes afterwards (s)", async () => {
    const original = '{"model":"user/model"}';
    await writeConfig(original);
    faults.path = configPath();
    await expect(runInstall()).rejects.toMatchObject({ code: "ENOSPC" });
    faults.path = undefined;
    expect(await readFile(configPath(), "utf8")).toBe(original);
    expect(JSON.parse(await readFile(paths.manifest, "utf8")).progress).toBe("instructions");
    expect(await check(io, paths)).toBe(1);
    expect(printed()).toContain("Instalación incompleta o retirada");
    await runInstall();
    expect(await check(io, paths)).toBe(0);
    expect((parseDocument(await readFile(configPath(), "utf8")) as any).plugins).toHaveLength(1);
  });
  it("refuses a data directory with unsafe permissions before touching anything and recovers after fixing them (t)", async () => {
    await writeConfig("{}");
    await chmod(paths.data, 0o777);
    try {
      await expect(runInstall()).rejects.toThrow("permisos seguros");
      expect(prepare).not.toHaveBeenCalled();
      expect(await readFile(configPath(), "utf8")).toBe("{}");
      expect(await readFile(paths.manifest, "utf8").catch(() => undefined)).toBeUndefined();
    } finally { await chmod(paths.data, 0o700); }
    await runInstall();
    expect(await check(io, paths)).toBe(0);
  });
  it("installs and checks with zero network attempts (z: instalar no conecta a Jira)", async () => {
    const attempts: string[] = [];
    const originalFetch = globalThis.fetch;
    const originals = [http.request, http.get, https.request, https.get];
    globalThis.fetch = ((input: unknown) => {
      attempts.push(typeof input === "string" || input instanceof URL ? String(input) : String((input as { url?: unknown })?.url ?? input));
      throw new Error("network prohibited during installer campaign");
    }) as typeof fetch;
    for (const [module, names] of [[http, ["request", "get"] as const], [https, ["request", "get"] as const]] as const) {
      for (const name of names) {
        (module as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
          attempts.push(String(args[0]));
          throw new Error("network prohibited during installer campaign");
        };
      }
    }
    try {
      await runInstall();
      expect(await check(io, paths)).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      http.request = originals[0]!; http.get = originals[1]!; https.request = originals[2]!; https.get = originals[3]!;
    }
    expect(attempts).toEqual([]);
  });
  it("rejects a candidate that declares installation scripts before activating it (z: sin postinstall)", async () => {
    await runInstall();
    const next = await candidate("0.4.0");
    const path = join(next.installed, "package.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...manifest, scripts: { ...manifest.scripts, postinstall: "echo pwned" } }));
    const before = await readFile(configPath(), "utf8");
    await expect(runInstall()).rejects.toThrow("scripts de instalación no admitidos");
    expect(await readFile(configPath(), "utf8")).toBe(before);
    expect(await check(io, paths)).toBe(0);
  });
});
