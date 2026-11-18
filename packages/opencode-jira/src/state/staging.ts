import { constants } from "node:fs";
import { lstat, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { within, type Config } from "../config.js";
import type { PinnedFile } from "../core/proposals.js";
import { cancellation, IssueKeeperError } from "../errors.js";
import { assertUploadUnchanged, openUploadSources, type UploadInput, type UploadSourceOptions } from "../uploads.js";
import { StateError } from "./errors.js";
import { safeAncestors } from "./files.js";
import type { ChangeStore } from "./store.js";

export interface StagingOptions extends UploadSourceOptions {
  limits: Pick<Config["attachments"], "maxFileBytes" | "maxBatchBytes" | "maxFilesPerUpload" | "transferTimeoutMs">;
  fault?: (point: "before-write" | "before-sync" | "after-copy", fileIndex: number) => void | Promise<void>;
}

export async function stageUploadFiles(store: ChangeStore, inputs: readonly UploadInput[], options: StagingOptions): Promise<PinnedFile[]> {
  cancellation(options.signal);
  const { limits } = options;
  if (within(options.location, store.paths.directory)) throw new StateError("UNSAFE_PATH");
  if (!Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0)
    || limits.maxFilesPerUpload > 20 || limits.maxFileBytes > 100 * 1024 * 1024 || limits.maxBatchBytes > 500 * 1024 * 1024
    || limits.transferTimeoutMs > 600000 || limits.maxFileBytes > limits.maxBatchBytes || !inputs.length || inputs.length > limits.maxFilesPerUpload) {
    throw new StateError("INVALID");
  }
  const sources = await openUploadSources(inputs, options);
  let reservation: ReturnType<ChangeStore["reserveStaging"]> | undefined;
  let directory: FileHandle | undefined;
  const created: Array<{ ref: string; handle: FileHandle }> = [];
  let complete = false;
  let contextFailed = false;
  try {
    let total = 0;
    for (const source of sources) {
      total += source.initial.size;
      if (!Number.isSafeInteger(total) || source.initial.size > limits.maxFileBytes || total > limits.maxBatchBytes) {
        throw new IssueKeeperError("ATTACHMENT_TOO_LARGE", "Los orígenes exceden el límite individual o acumulado de carga.");
      }
    }
    cancellation(options.signal);
    reservation = store.reserveStaging(total);
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(limits.transferTimeoutMs)]);
    safeAncestors(store.paths.staging);
    directory = await open(store.paths.staging, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = await directory.stat();
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700
      || await realpath(`/proc/self/fd/${directory.fd}`) !== store.paths.staging) throw new StateError("UNSAFE_PATH");
    const files: PinnedFile[] = [];
    const buffer = Buffer.alloc(65536);
    for (const [index, source] of sources.entries()) {
      cancellation(signal); reservation.check();
      const ref = `upload-${randomUUID()}`;
      const handle = await open(`/proc/self/fd/${directory.fd}/${ref}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created.push({ ref, handle });
      const hash = createHash("sha256");
      let size = 0;
      for (;;) {
        cancellation(signal);
        const { bytesRead } = await source.handle.read(buffer, 0, Math.min(buffer.length, source.initial.size - size + 1), size);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > source.initial.size) throw new IssueKeeperError("TRANSFER_INCOMPLETE", "El origen cambió durante la preparación.");
        hash.update(buffer.subarray(0, bytesRead));
        let offset = 0;
        while (offset < bytesRead) {
          cancellation(signal); reservation.check();
          await options.fault?.("before-write", index);
          cancellation(signal);
          const { bytesWritten } = await handle.write(buffer, offset, bytesRead - offset);
          if (!bytesWritten) throw new StateError("IO");
          offset += bytesWritten;
        }
      }
      if (size !== source.initial.size) throw new IssueKeeperError("TRANSFER_INCOMPLETE", "El origen cambió durante la preparación.");
      await options.fault?.("before-sync", index);
      await handle.sync();
      await assertUploadUnchanged(source);
      files.push({ stagedRef: ref, publishedName: source.publishedName, size, sha256: hash.digest("hex") });
      await options.fault?.("after-copy", index);
    }
    try { await options.revalidateContext(); }
    catch (error) { contextFailed = true; throw error; }
    cancellation(signal);
    for (const source of sources) await assertUploadUnchanged(source);
    if (await realpath(`/proc/self/fd/${directory.fd}`) !== store.paths.staging) throw new StateError("UNSAFE_PATH");
    await directory.sync();
    cancellation(signal);
    for (const file of created) store.registerStagedFile(file.ref, await file.handle.stat());
    complete = true;
    return files;
  } catch (error) {
    cancellation(options.signal);
    if (contextFailed) throw error;
    if (error instanceof IssueKeeperError || error instanceof StateError) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") throw new IssueKeeperError("TIMEOUT", "La copia local excedió el tiempo de transferencia.");
    throw new StateError("IO");
  } finally {
    try {
      if (!complete && directory) {
        for (const file of created) {
          const path = `/proc/self/fd/${directory.fd}/${file.ref}`;
          const own = await file.handle.stat();
          try {
            const current = await lstat(path);
            if (current.dev === own.dev && current.ino === own.ino && current.nlink === 1 && current.isFile()) await unlink(path);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new StateError("IO"); }
        }
        await directory.sync();
      }
    } finally {
      await Promise.allSettled([...sources.map((source) => source.handle.close()), ...created.map((file) => file.handle.close()), ...(directory ? [directory.close()] : [])]);
      reservation?.release();
    }
  }
}
