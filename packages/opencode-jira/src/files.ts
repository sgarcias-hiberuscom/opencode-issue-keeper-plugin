import { constants } from "node:fs";
import { link, mkdir, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { basename, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { cancellation, IssueKeeperError } from "./errors.js";
import { within } from "./config.js";

export interface DownloadPlan { directory: string; filename: string; temporaryName: string }

export function planDownload(directory: string, filename: string, attachmentId: string, destinationName?: string): DownloadPlan {
  const clean = filename.normalize("NFKC").replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^[. -]+|[. ]+$/g, "").slice(0, 100);
  return { directory, filename: destinationName ?? `${attachmentId}-${clean || "attachment"}`, temporaryName: `.transfer-${randomUUID()}.part` };
}

async function secureDirectory(directory: string, location: string): Promise<FileHandle> {
  if (process.platform !== "linux") throw new IssueKeeperError("CAPABILITY_NOT_SUPPORTED", "La descarga segura requiere Linux con /proc/self/fd en esta versión.");
  if (!within(location, directory) || directory === resolve(location)) throw new IssueKeeperError("FILE_ACCESS_DENIED", "Destino fuera de la raíz autorizada.");
  let handle = await open(parsePath(directory).root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let current = parsePath(directory).root;
  try {
    for (const part of directory.slice(current.length).split(sep)) {
      const child = `/proc/self/fd/${handle.fd}/${part}`;
      current = join(current, part);
      if (within(location, current) && current !== location) {
        await mkdir(child, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      }
      const next = await open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await handle.close();
      handle = next;
      const stat = await handle.stat();
      if (stat.uid !== 0 && stat.uid !== process.getuid?.()) throw new Error("untrusted ancestor owner");
      if (current === location && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)) throw new Error("writable location");
      if (within(location, current) && current !== location) {
        if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("unsafe directory");
      }
    }
    if (await realpath(`/proc/self/fd/${handle.fd}`) !== directory) throw new Error("directory moved");
    return handle;
  } catch {
    await handle.close();
    throw new IssueKeeperError("FILE_ACCESS_DENIED", "Destino no seguro; revise propietario, modo 0700 y ausencia de enlaces simbólicos.");
  }
}

export async function saveDownload(
  response: Response, plan: DownloadPlan, location: string,
  expectedSize: number, maxBytes: number, signal: AbortSignal,
): Promise<{ path: string; size: number; sha256: string }> {
  if (basename(plan.filename) !== plan.filename || basename(plan.temporaryName) !== plan.temporaryName) throw new IssueKeeperError("FILE_ACCESS_DENIED", "Nombre de destino inválido.");
  cancellation(signal);
  if (expectedSize > maxBytes) throw new IssueKeeperError("ATTACHMENT_TOO_LARGE", "El adjunto excede el límite local.");
  if (response.status !== 200 || !response.body) throw new IssueKeeperError("TRANSFER_INCOMPLETE", "Respuesta binaria incompleta.");
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body.cancel();
    throw new IssueKeeperError("ATTACHMENT_TOO_LARGE", "La descarga excede el tamaño permitido.");
  }
  const directory = await secureDirectory(plan.directory, location);
  const temp = `/proc/self/fd/${directory.fd}/${plan.temporaryName}`;
  const destination = `/proc/self/fd/${directory.fd}/${plan.filename}`;
  let file: FileHandle | undefined;
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash("sha256");
    let size = 0;
    for (;;) {
      cancellation(signal);
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new IssueKeeperError("ATTACHMENT_TOO_LARGE", "El stream excede el límite de descarga.");
      if (size > expectedSize) throw new IssueKeeperError("TRANSFER_INCOMPLETE", "El tamaño difiere de la metadata; vuelva a listar el adjunto.");
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
        if (!bytesWritten) throw new Error("short write");
        offset += bytesWritten;
      }
    }
    cancellation(signal);
    if (size !== expectedSize) throw new IssueKeeperError("TRANSFER_INCOMPLETE", "Descarga incompleta; el tamaño no coincide con la metadata.");
    await file.sync();
    if (await realpath(`/proc/self/fd/${directory.fd}`) !== plan.directory) throw new IssueKeeperError("FILE_ACCESS_DENIED", "El directorio cambió durante la descarga.");
    // link is atomic and fails if the destination exists; rename could overwrite it.
    await link(temp, destination);
    return { path: relative(location, join(plan.directory, plan.filename)), size, sha256: hash.digest("hex") };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof IssueKeeperError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new IssueKeeperError("FILE_ACCESS_DENIED", "El destino ya existe; elija otro nombre. No se ha sobrescrito.");
    throw new IssueKeeperError("TRANSFER_INCOMPLETE", "No se pudo completar la descarga; revise espacio y permisos locales.");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    if (file) {
      await file.close();
      await unlink(temp).catch(() => {});
    }
    await directory.close();
  }
}
