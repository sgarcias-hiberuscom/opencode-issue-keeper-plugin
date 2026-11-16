import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export async function safeAncestors(path: string): Promise<void> {
  const parts: string[] = [];
  let current = path;
  for (;;) {
    parts.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const part of parts.reverse()) {
    const stat = await lstat(part).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (stat?.isSymbolicLink() || stat && part !== path && !stat.isDirectory()) throw new Error("Ruta de instalación no segura; no se admiten enlaces simbólicos.");
  }
}
export async function privateDirectory(path: string): Promise<void> {
  await safeAncestors(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)) throw new Error("Directorio de instalación sin propiedad o permisos seguros.");
}
export async function readOptional(path: string): Promise<string | undefined> {
  await safeAncestors(path);
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("Archivo de instalación no regular o demasiado grande.");
    return await file.readFile("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally { await file?.close(); }
}
export async function atomicWrite(path: string, content: string, expected: string | undefined, backupDir?: string): Promise<void> {
  await privateDirectory(dirname(path));
  if (await readOptional(path) !== expected) throw new Error("El archivo cambió durante la operación; no se ha sobrescrito.");
  if (expected === content) return;
  if (backupDir && expected !== undefined) {
    await privateDirectory(backupDir);
    await writeFile(join(backupDir, `${randomUUID()}.backup`), expected, { flag: "wx", mode: 0o600 });
  }
  const temporary = join(dirname(path), `.issuekeeper-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(content); await file.sync(); }
    finally { await file.close(); }
    if (await readOptional(path) !== expected) throw new Error("Edición concurrente detectada; repita la operación.");
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}
export async function removeUnchanged(path: string, expectedHash: string): Promise<boolean> {
  const content = await readOptional(path);
  if (content === undefined || hash(content) !== expectedHash) return false;
  await unlink(path);
  return true;
}
