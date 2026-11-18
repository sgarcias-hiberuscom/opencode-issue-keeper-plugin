import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(dirname(fileURLToPath(import.meta.url)));
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: directory, encoding: "utf8" }).trim();
const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const commit = git("rev-parse", "HEAD").toString().trim();
const sourcePaths = ["packages/opencode-jira", ".github/workflows/jira-read.yml", ".opencode/commands"];
const split = (buffer) => buffer.toString().split("\0").filter(Boolean);
const inScope = (path) => !path.startsWith(".opencode/commands/") || /^\.opencode\/commands\/jira-[^/]+\.md$/.test(path);
const baseline = split(git("ls-tree", "-r", "--name-only", "-z", commit, "--", ...sourcePaths)).filter(inScope);
const current = split(git("ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "-z", "--", ...sourcePaths)).filter(inScope);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sources = [];
for (const path of [...new Set([...baseline, ...current])].sort()) {
  const entry = { path };
  if (baseline.includes(path)) entry.baselineSha256 = sha256(git("show", `${commit}:${path}`));
  try {
    const stat = await lstat(join(root, path));
    if (stat.isFile()) entry.workingSha256 = sha256(await readFile(join(root, path)));
    else entry.workingKind = stat.isSymbolicLink() ? "symlink-not-followed" : "nonregular-not-read";
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    entry.workingKind = "missing";
  }
  sources.push(entry);
}
const versions = {};
for (const name of ["@opencode/plugin", "zod", "jsonc-parser", "better-sqlite3", "mdast-util-from-markdown", "mdast-util-gfm-table", "micromark-extension-gfm-table", "typescript", "vitest"]) {
  versions[name] = JSON.parse(await readFile(join(directory, "node_modules", name, "package.json"), "utf8")).version;
}
const outputDirectory = join(directory, "reports", "phase2");
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const stat = await lstat(outputDirectory);
if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 || await realpath(outputDirectory) !== outputDirectory) throw new Error("El directorio del informe debe ser privado y no contener enlaces.");
const capturedAt = new Date().toISOString();
const output = join(outputDirectory, `baseline-${capturedAt.replaceAll(":", "-")}.json`);
await writeFile(output, JSON.stringify({
  schemaVersion: 1, capturedAt, commit, node: process.version, platform: process.platform, arch: process.arch, versions,
  package: JSON.parse(await readFile(join(directory, "package.json"), "utf8")).version,
  sources,
  notInspected: ["credentials", "active-installed-copy", "Jira", "laboratory-profiles", "human-approvals"],
  note: "Manifiesto de fuentes, no resultado de suites ni cierre de PRE-01/G0. No se consultan secretos o configuración del usuario.",
}, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(`Manifiesto privado: ${relative(directory, output)} (${sources.length} fuentes).`);
