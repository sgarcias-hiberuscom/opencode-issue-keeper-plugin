import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

interface PackedFile { path: string; size: number; mode: number }
interface Packed { name: string; version: string; filename: string; entryCount: number; files: PackedFile[] }

// Revisión del contenido efectivo del tarball (8.4): npm pack --dry-run ejecuta `prepack` (build).
const parsed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: packageRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 300_000,
}));
const packed: Packed = (Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0])!;
const paths = packed.files.map((file) => file.path);

describe("[8.4][T13] distributed package content", () => {
  it("contains only allowlisted paths, without duplicates or omissions", () => {
    const allowed: (string | RegExp)[] = [
      /^dist\/[\w/.-]+\.js$/,
      /^dist\/[\w/.-]+\.d\.ts$/,
      /^templates\/[\w./-]+$/,
      "README.md", "LICENSE", "CHANGELOG.md", "SECURITY.md", "options.schema.json", "opencode.example.jsonc", "package.json",
    ];
    const extras = paths.filter((path) => !allowed.some((pattern) => typeof pattern === "string" ? pattern === path : pattern.test(path)));
    expect(extras).toEqual([]);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toHaveLength(packed.entryCount);
  });
  it("includes the CLI, templates, schema and the distributed documentation", () => {
    for (const required of ["dist/index.js", "dist/cli.js", "templates/jira.md", "templates/account.example.jsonc", "templates/commands/jira-get.md", "templates/commands/jira-list.md", "templates/commands/jira-update.md", "options.schema.json", "opencode.example.jsonc", "README.md", "LICENSE", "CHANGELOG.md", "SECURITY.md", "package.json"]) {
      expect(paths, required).toContain(required);
    }
    expect(packed.name).toBe("@issuekeeper/opencode-jira");
    expect(packed.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
  it("excludes development trees, caches and archives", () => {
    for (const prefix of ["src/", "test/", "scripts/", "reports/", "coverage/", "node_modules/", "."]) {
      expect(paths.some((path) => path.startsWith(prefix)), prefix).toBe(false);
    }
    for (const suffix of [".tgz", ".tsbuildinfo", ".log", ".map"]) {
      expect(paths.some((path) => path.endsWith(suffix)), suffix).toBe(false);
    }
  });
  it("has no install scripts, exact dependency versions, private scope and an unset license", async () => {
    const pkg = JSON.parse(await read("../../package.json"));
    for (const script of ["preinstall", "install", "postinstall"]) expect(pkg.scripts?.[script]).toBeUndefined();
    const exact = (version: unknown) => typeof version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
    for (const [name, version] of Object.entries(pkg.dependencies)) expect(`${name}@${version}`, "dependency").toSatisfy(() => exact(version));
    for (const [name, version] of Object.entries(pkg.devDependencies)) expect(`${name}@${version}`, "devDependency").toSatisfy(() => exact(version));
    expect(pkg.private).toBe(true);
    expect(pkg.license).toBe("UNLICENSED");
  });
});
