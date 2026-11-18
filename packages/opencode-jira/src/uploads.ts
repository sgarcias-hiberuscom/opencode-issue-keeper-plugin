import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { safeRoot, within } from "./config.js";
import { PinnedFileSchema } from "./core/proposals.js";
import { cancellation, IssueKeeperError } from "./errors.js";

export interface UploadInput { path: string; publishedName: string }
export interface UploadSourceOptions {
  location: string;
  uploadRoots: readonly string[];
  deniedPaths: readonly string[];
  signal: AbortSignal;
  authorizeRead: (absolutePath: string) => Promise<void>;
  revalidateContext: () => Promise<void>;
}
export interface UploadSource {
  handle: FileHandle;
  path: string;
  publishedName: string;
  initial: Stats;
}

function denied(): never { throw new IssueKeeperError("FILE_ACCESS_DENIED", "Origen de carga no seguro o fuera de las raíces autorizadas."); }
function sensitive(path: string): boolean {
  return path.split(sep).some((part) => /^(?:\.git|\.ssh|\.config|\.aws|\.gnupg|node_modules|secrets|credentials|id_rsa|id_ed25519)$/i.test(part)
    || /^\.env(?:\.|$)/i.test(part) || /\.(?:pem|key)$/i.test(part));
}

async function openSource(path: string, location: string): Promise<FileHandle> {
  let directory = await open(parse(path).root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    let current = parse(path).root;
    const parts = path.slice(current.length).split(sep);
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      const next = await open(`/proc/self/fd/${directory.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close(); directory = next;
      const stat = await directory.stat();
      if (stat.uid !== 0 && stat.uid !== process.getuid?.()) denied();
      if (within(location, current) && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)) denied();
    }
    const child = `/proc/self/fd/${directory.fd}/${parts.at(-1)!}`;
    if (!(await lstat(child)).isFile()) denied();
    const file = await open(child, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o133) !== 0
        || await realpath(`/proc/self/fd/${file.fd}`) !== path) denied();
      return file;
    } catch (error) { await file.close(); throw error; }
  } finally { await directory.close(); }
}

export async function assertUploadUnchanged(source: UploadSource): Promise<void> {
  try {
    const stat = await source.handle.stat();
    const before = source.initial;
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size
      || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs || stat.nlink !== 1
      || stat.uid !== process.getuid?.() || (stat.mode & 0o133) !== 0
      || await realpath(`/proc/self/fd/${source.handle.fd}`) !== source.path) denied();
  } catch { denied(); }
}

export async function openUploadSources(inputs: readonly UploadInput[], options: UploadSourceOptions): Promise<UploadSource[]> {
  cancellation(options.signal);
  if (!inputs.length || inputs.length > 20) denied();
  if (process.platform !== "linux") throw new IssueKeeperError("CAPABILITY_NOT_SUPPORTED", "La lectura segura de cargas requiere Linux con /proc/self/fd.");
  if (!isAbsolute(options.location) || resolve(options.location) !== options.location || options.deniedPaths.some((path) => !isAbsolute(path))) denied();
  const roots = options.uploadRoots.map((root) => safeRoot(root, options.location));
  const paths = inputs.map((input) => {
    if (!input.path || input.path.includes("\0") || input.path.length > 4096
      || !PinnedFileSchema.shape.publishedName.safeParse(input.publishedName).success) denied();
    const path = resolve(options.location, input.path);
    if (!roots.some((root) => within(root, path) && root !== path) || sensitive(relative(options.location, path))
      || options.deniedPaths.some((secret) => within(resolve(secret), path))) denied();
    return path;
  });
  const sources: UploadSource[] = [];
  try {
    for (const [index, path] of paths.entries()) {
      await options.authorizeRead(path);
      cancellation(options.signal);
      await options.revalidateContext();
      cancellation(options.signal);
      let handle: FileHandle;
      try { handle = await openSource(path, options.location); }
      catch { denied(); }
      try { sources.push({ handle, path, publishedName: inputs[index]!.publishedName, initial: await handle.stat() }); }
      catch (error) { await handle.close(); throw error; }
    }
    return sources;
  } catch (error) { await Promise.all(sources.map((source) => source.handle.close())); throw error; }
}
