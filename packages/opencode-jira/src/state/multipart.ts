import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { PinnedFileSchema, type PinnedFile } from "../core/proposals.js";
import { safeAncestors } from "./files.js";
import { StateError } from "./errors.js";

export interface PinnedMultipart { body: ReadableStream<Uint8Array>; boundary: string; contentLength: number; close: () => Promise<void> }
export async function pinnedMultipart(staging: string, input: PinnedFile, signal: AbortSignal): Promise<PinnedMultipart> {
  signal.throwIfAborted();
  const parsed = PinnedFileSchema.safeParse(input); if (!parsed.success) throw new StateError("INVALID");
  const file = parsed.data; if (file.publishedName.includes('"')) throw new StateError("INVALID"); safeAncestors(staging);
  const directory = await open(staging, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let handle: FileHandle | undefined;
  try {
    const stat = await directory.stat();
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 || await realpath(`/proc/self/fd/${directory.fd}`) !== staging) throw new StateError("UNSAFE_PATH");
    handle = await open(`/proc/self/fd/${directory.fd}/${file.stagedRef}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const actual = await handle.stat();
    if (!actual.isFile() || actual.uid !== process.getuid?.() || actual.nlink !== 1 || (actual.mode & 0o777) !== 0o600 || actual.size !== file.size
      || await realpath(`/proc/self/fd/${handle.fd}`) !== join(staging, file.stagedRef)) throw new StateError("CORRUPT");
    const buffer = Buffer.alloc(65536); const hash = createHash("sha256"); let position = 0;
    while (position < file.size) {
      signal.throwIfAborted(); const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, file.size - position), position);
      if (!bytesRead) throw new StateError("CORRUPT"); hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    if (hash.digest("hex") !== file.sha256 || (await handle.stat()).size !== file.size) throw new StateError("CORRUPT");
    const source = handle;
    let closed: Promise<void> | undefined;
    const close = () => closed ??= source.close();
    const boundary = `issuekeeper-${randomUUID()}`;
    const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.publishedName.replaceAll('"', "%22")}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const streamed = createHash("sha256"); let offset = 0; let started = false; let finished = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          signal.throwIfAborted();
          if (!started) { started = true; controller.enqueue(prefix); return; }
          if (offset < file.size) {
            const chunk = Buffer.alloc(Math.min(65536, file.size - offset)); const { bytesRead } = await source.read(chunk, 0, chunk.length, offset);
            if (!bytesRead) throw new StateError("CORRUPT"); offset += bytesRead; streamed.update(chunk.subarray(0, bytesRead)); controller.enqueue(chunk.subarray(0, bytesRead)); return;
          }
          if (!finished) {
            finished = true;
            if (streamed.digest("hex") !== file.sha256 || (await source.stat()).size !== file.size) throw new StateError("CORRUPT");
            controller.enqueue(suffix); controller.close(); await close();
          }
        } catch (error) { controller.error(error); await close(); }
      },
      cancel: close,
    }, { highWaterMark: 0 });
    return { body, boundary, contentLength: prefix.byteLength + file.size + suffix.byteLength, close };
  } catch (error) { await handle?.close(); throw error; }
  finally { await directory.close(); }
}
