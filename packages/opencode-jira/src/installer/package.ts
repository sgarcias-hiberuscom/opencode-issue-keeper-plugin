import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFile, mkdtemp, rm, rename, lstat, open, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { hash, privateDirectory, readOptional, safeAncestors } from "./files.js";

const exec = promisify(execFile);
export const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
export const packageName = "@issuekeeper/opencode-jira";
const required = ["dist/index.js", "dist/cli.js", "templates/jira.md", "templates/account.example.jsonc", "options.schema.json"];

function validateManifest(manifest: Record<string, any>, version: string): void {
  if (manifest.name !== packageName || manifest.version !== version || manifest.exports?.["."] !== "./dist/index.js"
    || manifest.type !== "module" || manifest.private !== true
    || manifest.bin?.["issuekeeper-jira"] !== "./dist/cli.js" || manifest.scripts?.preinstall || manifest.scripts?.postinstall || manifest.scripts?.install
    || manifest.dependencies?.["@opencode/plugin"] !== "2.2.5" || manifest.dependencies?.zod !== "4.6.7"
    || manifest.dependencies?.["jsonc-parser"] !== "3.3.1"
    || Object.keys(manifest.dependencies ?? {}).length !== 3) throw new Error("Paquete incompatible o con scripts de instalación no admitidos.");
}

export async function validatePackage(root: string, version: string): Promise<void> {
  const manifest = JSON.parse((await readOptional(join(root, "package.json"))) ?? "null");
  if (!manifest || typeof manifest !== "object") throw new Error("Paquete incompleto.");
  validateManifest(manifest, version);
  for (const file of required) {
    if (await readOptional(join(root, file)) === undefined) throw new Error("Paquete incompleto; ejecute build antes de empaquetar.");
  }
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
    validateManifest(manifest, own.version);
    const digest = hash(await readFile(archive));
    const release = join(data, "copies", digest);
    const installed = join(release, "node_modules", packageName);
    if (await readOptional(join(installed, "package.json")) !== undefined) {
      await validatePackage(installed, own.version);
      await validateDependencies(release);
      return { installed, version: own.version as string };
    }
    const staging = join(scratch, "installation");
    await privateDirectory(staging);
    await writeFile(join(staging, "package.json"), JSON.stringify({ name: "issuekeeper-jira-installation", private: true, type: "module" }), { mode: 0o600, flag: "wx" });
    await writeFile(join(staging, "source.tgz"), await readFile(archive), { mode: 0o600, flag: "wx" });
    await exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "./source.tgz"], { cwd: staging, maxBuffer: 8 * 1024 * 1024 });
    await validatePackage(join(staging, "node_modules", packageName), own.version);
    for (const dependency of ["@opencode/plugin", "zod", "jsonc-parser"]) {
      if (await readOptional(join(staging, "node_modules", dependency, "package.json")) === undefined) throw new Error("Dependencias incompletas.");
    }
    await validateDependencies(staging);
    await privateDirectory(dirname(release));
    await rename(staging, release);
    return { installed, version: own.version as string };
  } catch {
    throw new Error("No se pudo preparar el paquete; la copia activa y la configuración no han cambiado.");
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
