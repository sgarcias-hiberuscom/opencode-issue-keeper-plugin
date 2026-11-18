import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, normalize } from "node:path";
import { StateError } from "./errors.js";
import type { PinnedFile } from "../core/proposals.js";

export function safeAncestors(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path) throw new StateError("UNSAFE_PATH");
  for (let current = path;; current = dirname(current)) {
    try { const stat = lstatSync(current); if (stat.isSymbolicLink() || current !== path && !stat.isDirectory()) throw new StateError("UNSAFE_PATH"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (dirname(current) === current) break;
  }
}
export function privateDirectory(path: string): void {
  safeAncestors(path);
  const missing: string[] = [];
  for (let current = path; !existsSync(current); current = dirname(current)) missing.push(current);
  mkdirSync(path, { mode: 0o700, recursive: true });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 || realpathSync(path) !== path) throw new StateError("UNSAFE_PATH");
  for (const created of missing.reverse()) syncDirectory(dirname(created));
}
export function assertPrivateFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) throw new StateError("UNSAFE_PATH");
}
// Never open/close an existing SQLite inode here: POSIX locks belong to the process.
export function ensurePrivateFile(path: string): boolean {
  try { assertPrivateFile(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  closeSync(descriptor);
  assertPrivateFile(path);
  return true;
}
export function checkSidecars(path: string): void {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try { assertPrivateFile(path + suffix); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
export function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
export function verifyPinnedFile(path: string, expected: Pick<PinnedFile, "size" | "sha256">, allowMissing = false): boolean {
  if (allowMissing && !existsSync(path)) {
    try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  assertPrivateFile(path);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size !== expected.size) throw new StateError("CORRUPT");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(65536);
    let count = 0;
    for (;;) {
      const length = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!length) break;
      count += length;
      if (count > expected.size) throw new StateError("CORRUPT");
      hash.update(buffer.subarray(0, length));
    }
    if (count !== expected.size || hash.digest("hex") !== expected.sha256) throw new StateError("CORRUPT");
    const after = lstatSync(path);
    if (after.dev !== stat.dev || after.ino !== stat.ino) throw new StateError("UNSAFE_PATH");
    return true;
  } finally { closeSync(descriptor); }
}
