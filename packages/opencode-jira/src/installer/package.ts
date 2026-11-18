import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFile, mkdtemp, rm, rename, lstat, open, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { stateCompatibility } from "../state/store.js";
import { hash, privateDirectory, readOptional, safeAncestors } from "./files.js";

const exec = promisify(execFile);
export const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
export const packageName = "@issuekeeper/opencode-jira";
const required = ["dist/index.js", "dist/cli.js", "dist/uploads.js", "dist/core/proposals.js", "dist/core/review.js", "dist/core/markdown.js", "dist/core/comment.js", "dist/core/adf-document.js", "dist/core/metadata.js", "dist/core/change-policy.js", "dist/state/store.js", "dist/state/coordinator.js", "dist/state/files.js", "dist/state/paths.js", "dist/state/errors.js", "dist/state/application.js", "dist/state/runtime.js", "dist/state/staging.js", "dist/state/multipart.js", "dist/state/review.js", "dist/state/operator.js", "dist/jira/changes.js", "dist/jira/mutations.js", "dist/jira/audience.js", "dist/jira/preparation.js", "dist/jira/attachment-links.js", "dist/tools/changes.js", "dist/tools/shared.js", "dist/tools/change-schemas.js", "dist/tools/change-permissions.js", "templates/jira.md", "templates/account.example.jsonc", "templates/commands/jira-get.md", "templates/commands/jira-list.md", "templates/commands/jira-update.md", "options.schema.json"];

function validateManifest(manifest: Record<string, any>, version: string): void {
  if (manifest.name !== packageName || manifest.version !== version || typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) || manifest.exports?.["."] !== "./dist/index.js"
    || manifest.type !== "module" || manifest.private !== true
    || manifest.bin?.["issuekeeper-jira"] !== "./dist/cli.js" || manifest.scripts?.preinstall || manifest.scripts?.postinstall || manifest.scripts?.install
    || manifest.dependencies?.["@opencode/plugin"] !== "2.2.5" || manifest.dependencies?.zod !== "4.6.7"
    || manifest.dependencies?.["jsonc-parser"] !== "3.3.1"
    || manifest.dependencies?.["better-sqlite3"] !== "13.2.0"
    || manifest.dependencies?.["mdast-util-from-markdown"] !== "2.0.2"
    || manifest.dependencies?.["mdast-util-gfm-table"] !== "2.0.0"
    || manifest.dependencies?.["micromark-extension-gfm-table"] !== "2.1.1"
    || manifest.issuekeeperState?.database !== stateCompatibility.database || manifest.issuekeeperState?.plan !== stateCompatibility.plan
    || Object.keys(manifest.dependencies ?? {}).length !== 7) throw new Error("Paquete incompatible o con scripts de instalación no admitidos.");
}

export function validateStorageEngine(root: string): void {
  try {
    const require = createRequire(join(root, "package.json"));
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    try { if (!db.prepare("SELECT sqlite_version() AS version").get()) throw new Error(); }
    finally { db.close(); }
  } catch { throw new Error("El motor SQLite incluido no funciona en este runtime; no se activará la copia preparada."); }
}

export async function validatePackage(root: string, version: string): Promise<void> {
  const manifest = JSON.parse((await readOptional(join(root, "package.json"))) ?? "null");
  if (!manifest || typeof manifest !== "object") throw new Error("Paquete incompleto.");
  validateManifest(manifest, version);
  for (const file of required) {
    if (await readOptional(join(root, file)) === undefined) throw new Error("Paquete incompleto; ejecute build antes de empaquetar.");
  }
  for (const file of ["README.md", "opencode.example.jsonc"]) if (await readOptional(join(root, file)) === undefined) throw new Error("Documentación distribuida incompleta.");
  if (!(await readFile(join(root, "dist/cli.js"), "utf8")).startsWith("#!/usr/bin/env node")) throw new Error("CLI sin shebang.");
}

export async function validateDependencies(root: string): Promise<void> {
  const lock = JSON.parse((await readOptional(join(root, "package-lock.json"))) ?? "{}") as {
    packages?: Record<string, { version?: string; optional?: boolean; link?: boolean }>;
  };
  if (!lock.packages || !Object.keys(lock.packages).length) throw new Error("Lock de instalación ausente o inválido.");
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    if (!path.startsWith("node_modules/") || path.split("/").includes("..") || entry.link) throw new Error("Lock con rutas no admitidas.");
    const metadata = await readOptional(join(root, path, "package.json"));
    if (metadata === undefined && entry.optional) continue;
    if (metadata === undefined || JSON.parse(metadata).version !== entry.version) throw new Error("Árbol de dependencias incompleto o distinto del lock.");
  }
}

export async function preparePackage(source: string, data: string) {
  const own = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  await privateDirectory(data);
  const scratch = await mkdtemp(join(data, ".prepare-"));
  try {
    let archive: string;
    if (source === "local") {
      await validatePackage(packageRoot, own.version);
      const { stdout } = await exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], { cwd: packageRoot, maxBuffer: 8 * 1024 * 1024 });
      const result = JSON.parse(stdout);
      const packed = Array.isArray(result) ? result[0] : Object.values(result)[0];
      archive = join(scratch, packed.filename);
    } else {
      const origin = resolve(source);
      await safeAncestors(origin);
      if (!origin.endsWith(".tgz")) throw new Error("El origen debe ser un tarball .tgz regular.");
      const file = await open(origin, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("Tarball no regular o demasiado grande.");
        archive = join(scratch, "source.tgz");
        await writeFile(archive, await file.readFile(), { mode: 0o600, flag: "wx" });
      } finally { await file.close(); }
    }
    const { stdout: list } = await exec("tar", ["-tzf", archive], { maxBuffer: 8 * 1024 * 1024 });
    const entries = list.trim().split("\n");
    if (entries.some((entry) => !entry.startsWith("package/") || entry.split("/").includes("..") || entry.includes("\\"))
      || required.some((file) => !entries.includes(`package/${file}`))) throw new Error("Contenido de tarball no válido.");
    const { stdout: verbose } = await exec("tar", ["-tvzf", archive], { maxBuffer: 8 * 1024 * 1024 });
    if (verbose.split("\n").some((entry) => entry && !["-", "d"].includes(entry[0]!))) throw new Error("No se admiten enlaces en el tarball.");
    const { stdout: metadata } = await exec("tar", ["-xOf", archive, "package/package.json"], { maxBuffer: 1024 * 1024 });
    const manifest = JSON.parse(metadata);
    validateManifest(manifest, manifest.version);
    const version: string = manifest.version;
    const digest = hash(await readFile(archive));
    const release = join(data, "copies", digest);
    const installed = join(release, "node_modules", packageName);
    if (await readOptional(join(installed, "package.json")) !== undefined) {
      await validatePackage(installed, version);
      await validateDependencies(release);
      validateStorageEngine(release);
      return { installed, version };
    }
    const staging = join(scratch, "installation");
    await privateDirectory(staging);
    await writeFile(join(staging, "package.json"), JSON.stringify({ name: "issuekeeper-jira-installation", private: true, type: "module" }), { mode: 0o600, flag: "wx" });
    await writeFile(join(staging, "source.tgz"), await readFile(archive), { mode: 0o600, flag: "wx" });
    // The server SDK's optional UI peers belong to the host, not this isolated backend copy.
    await exec("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", "--save-exact", "./source.tgz"], { cwd: staging, maxBuffer: 8 * 1024 * 1024, timeout: 90000 });
    await validatePackage(join(staging, "node_modules", packageName), version);
    for (const dependency of ["@opencode/plugin", "zod", "jsonc-parser", "better-sqlite3"]) {
      if (await readOptional(join(staging, "node_modules", dependency, "package.json")) === undefined) throw new Error("Dependencias incompletas.");
    }
    await validateDependencies(staging);
    validateStorageEngine(staging);
    await privateDirectory(dirname(release));
    await rename(staging, release);
    return { installed, version };
  } catch {
    throw new Error("No se pudo preparar el paquete; la copia activa y la configuración no han cambiado.");
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
