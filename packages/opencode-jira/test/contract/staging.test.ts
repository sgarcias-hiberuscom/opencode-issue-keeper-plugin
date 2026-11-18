import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openUploadSources, type UploadInput } from "../../src/uploads.js";
import { stageUploadFiles, type StagingOptions } from "../../src/state/staging.js";
import { ChangeStore, type StoreOptions } from "../../src/state/store.js";
import { instant, planFixture } from "../state-fixtures.js";

const roots: string[] = [];
const stores: ChangeStore[] = [];
const children: ChildProcess[] = [];
async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
}
async function fixture(storeOptions: StoreOptions = {}) {
  const root = await mkdtemp("/tmp/opencode/jira-staging-"); roots.push(root);
  const location = join(root, "project"); const exports = join(location, "exports");
  await mkdir(exports, { recursive: true, mode: 0o700 });
  const data = join(root, "data"); const store = new ChangeStore(data, { now: () => new Date(instant), ...storeOptions }); stores.push(store);
  const options: StagingOptions = {
    location, uploadRoots: ["exports"], deniedPaths: [], signal: new AbortController().signal,
    authorizeRead: vi.fn(async () => {}), revalidateContext: vi.fn(async () => {}),
    limits: { maxFileBytes: 1024 * 1024, maxBatchBytes: 2 * 1024 * 1024, maxFilesPerUpload: 3, transferTimeoutMs: 10000 },
  };
  async function source(name = "source.bin", bytes: string | Buffer = "original"): Promise<UploadInput> {
    const path = join(exports, name); await writeFile(path, bytes, { mode: 0o600 });
    return { path, publishedName: name };
  }
  return { root, location, exports, data, store, options, source };
}
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const child of children.splice(0)) await kill(child);
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

describe("[ARC-01][UP-01][OP-03] authorized source descriptors", () => {
  it("asks for read before opening even a nonexistent source and propagates native refusal", async () => {
    const f = await fixture(); const original = new Error("native refusal");
    f.options.authorizeRead = vi.fn(async () => { throw original; });
    await expect(stageUploadFiles(f.store, [{ path: "exports/missing", publishedName: "missing" }], f.options)).rejects.toBe(original);
    expect(f.options.revalidateContext).not.toHaveBeenCalled(); expect(await readdir(f.store.paths.staging)).toEqual([]);
  });
  it("revalidates context after each permission, before opening", async () => {
    const f = await fixture(); const original = new Error("session moved");
    f.options.revalidateContext = async () => { throw original; };
    await expect(stageUploadFiles(f.store, [{ path: "exports/missing", publishedName: "missing" }], f.options)).rejects.toBe(original);
  });
  it.each(["../outside", "exports-other/file", "exports/../file", "exports/.env", "exports/.env.local", "exports/.git/config", "exports/secret.pem", "exports/secret.key", "exports/credentials", "exports/id_rsa"])("rejects unsafe path %s before permission", async (path) => {
    const f = await fixture();
    await expect(stageUploadFiles(f.store, [{ path, publishedName: "file" }], f.options)).rejects.toMatchObject({ code: "FILE_ACCESS_DENIED" });
    expect(f.options.authorizeRead).not.toHaveBeenCalled();
  });
  it.each(["../file", "a/b", "a\\b", "..", "a\r\nb"])("rejects publication name %j before permission", async (publishedName) => {
    const f = await fixture();
    await expect(stageUploadFiles(f.store, [{ path: "exports/file", publishedName }], f.options)).rejects.toMatchObject({ code: "FILE_ACCESS_DENIED" });
    expect(f.options.authorizeRead).not.toHaveBeenCalled();
  });
  it("excludes configured credential paths even inside an upload root", async () => {
    const f = await fixture(); const input = await f.source("innocent.txt"); f.options.deniedPaths = [input.path];
    await expect(stageUploadFiles(f.store, [input], f.options)).rejects.toMatchObject({ code: "FILE_ACCESS_DENIED" });
    expect(f.options.authorizeRead).not.toHaveBeenCalled();
  });
  it.each(["symlink", "ancestor-symlink", "hardlink", "executable", "writable", "directory", "fifo"])("rejects %s without content reads or FIFO blocking", async (variant) => {
    const f = await fixture(); const outside = join(f.root, "sentinel"); await writeFile(outside, "never copy", { mode: 0o600 });
    let path = join(f.exports, "file");
    if (variant === "symlink") await symlink(outside, path);
    if (variant === "ancestor-symlink") { await symlink(f.root, join(f.exports, "linked")); path = join(f.exports, "linked", "sentinel"); }
    if (variant === "hardlink") await link(outside, path);
    if (variant === "executable" || variant === "writable") { await writeFile(path, "keep"); await chmod(path, variant === "executable" ? 0o700 : 0o666); }
    if (variant === "directory") await mkdir(path);
    if (variant === "fifo") execFileSync("mkfifo", [path]);
    await expect(stageUploadFiles(f.store, [{ path, publishedName: "file" }], f.options)).rejects.toMatchObject({ code: "FILE_ACCESS_DENIED" });
    expect(await readdir(f.store.paths.staging)).toEqual([]); expect(await readFile(outside, "utf8")).toBe("never copy");
  });
  it("detects replacement with a symlink during the permission dialog", async () => {
    const f = await fixture(); const input = await f.source();
    const outside = join(f.root, "outside"); await writeFile(outside, "secret");
    f.options.authorizeRead = async () => { await rm(input.path); await symlink(outside, input.path); };
    await expect(stageUploadFiles(f.store, [input], f.options)).rejects.toMatchObject({ code: "FILE_ACCESS_DENIED" });
  });
  it("does not leak previously opened descriptors when a later read is refused", async () => {
    const f = await fixture(); const first = await f.source("one"); const second = await f.source("two");
    const original = new Error("second refused"); let calls = 0;
    f.options.authorizeRead = async () => { if (++calls === 2) throw original; };
    const before = (await readdir("/proc/self/fd")).length;
    await expect(openUploadSources([first, second], f.options)).rejects.toBe(original);
    expect((await readdir("/proc/self/fd")).length).toBe(before);
  });
});

describe("[ARC-02][UP-02–UP-04][UP-10] bounded private staging", () => {
  it.each([Buffer.alloc(0), Buffer.from("😀\r\nUnicode"), Buffer.alloc(200000, 0xab)])("pins exact bytes, hash and private modes for sample %#", async (bytes) => {
    const f = await fixture(); const input = await f.source("informe ñ.bin", bytes);
    const files = await stageUploadFiles(f.store, [input], f.options); const file = files[0]!;
    const path = join(f.store.paths.staging, file.stagedRef);
    expect(await readFile(path)).toEqual(bytes); expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(file.size).toBe(bytes.length); expect(file.publishedName).toBe(input.publishedName);
    expect((await lstat(path)).mode & 0o777).toBe(0o600); expect((await lstat(f.store.paths.staging)).mode & 0o777).toBe(0o700);
    await writeFile(input.path, "changed");
    const plan = planFixture({ kind: "upload", audience: "ticket", files, steps: [{ id: "step-1", kind: "mutation", fileRefs: [file.stagedRef] }] });
    f.store.prepare(plan); f.store.claim(plan.id, 0); expect(f.store.sending(plan.id, 1, "step-1").execution.steps[0]!.state).toBe("sending");
    expect(await readFile(path)).toEqual(bytes);
  }, 20000);
  it.each(["individual", "batch", "count"])("rejects the %s limit without staging any bytes", async (kind) => {
    const f = await fixture(); const input = await f.source("file", Buffer.alloc(10));
    if (kind === "individual") f.options.limits = { ...f.options.limits, maxFileBytes: 5 };
    if (kind === "batch") f.options.limits = { ...f.options.limits, maxFileBytes: 10, maxBatchBytes: 15 };
    if (kind === "count") f.options.limits.maxFilesPerUpload = 1;
    await expect(stageUploadFiles(f.store, kind === "individual" ? [input] : [input, input], f.options)).rejects.toBeInstanceOf(Error);
    expect(await readdir(f.store.paths.staging)).toEqual([]);
  });
  it("reserves global capacity before copying and preserves unrelated orphan files", async () => {
    const f = await fixture({ limits: { stagingBytes: 10 } }); const input = await f.source("file", Buffer.alloc(6));
    await writeFile(join(f.store.paths.staging, "unrelated"), "12345", { mode: 0o600 });
    await expect(stageUploadFiles(f.store, [input], f.options)).rejects.toMatchObject({ reason: "QUOTA" });
    expect(await readdir(f.store.paths.staging)).toEqual(["unrelated"]);
  });
  it("cleans eligible results under staging pressure before allocating the new bytes", async () => {
    let clock = instant;
    const f = await fixture({ now: () => new Date(clock), limits: { stagingBytes: 10 } });
    const input = await f.source("file", "123456"); const files = await stageUploadFiles(f.store, [input], f.options);
    f.store.prepare(planFixture({ kind: "upload", audience: "ticket", files, steps: [{ id: "step-1", kind: "mutation", fileRefs: [files[0]!.stagedRef] }] }));
    clock = "2026-11-17T11:00:00Z";
    const second = await stageUploadFiles(f.store, [input], f.options);
    expect(second).toHaveLength(1); expect(f.store.usage().stagingBytes).toBe(6);
    expect(() => f.store.get("proposal-1")).toThrow();
  });
  it("counts concurrent reservations and blocks close/maintenance until release", async () => {
    const f = await fixture({ limits: { stagingBytes: 10 } }); const input = await f.source("file", "123456");
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    f.options.fault = async (point) => { if (point === "before-write") { entered(); await new Promise<void>((resolve) => { release = resolve; }); } };
    const first = stageUploadFiles(f.store, [input], f.options); await started;
    try {
      expect(() => f.store.close()).toThrow(); expect(() => f.store.assertMaintenanceSafe()).toThrow();
      await expect(stageUploadFiles(f.store, [input], { ...f.options, fault: undefined })).rejects.toMatchObject({ reason: "QUOTA" });
    } finally { release(); await first; }
    expect(f.store.usage().stagingBytes).toBe(6); f.store.close();
  });
  it("rejects insufficient filesystem space before creating staging", async () => {
    const f = await fixture(); const input = await f.source();
    const actual = fs.statfsSync(f.store.paths.staging, { bigint: true });
    vi.spyOn(fs, "statfsSync").mockReturnValue({ ...actual, bavail: 0n } as never);
    syncBuiltinESMExports();
    await expect(stageUploadFiles(f.store, [input], f.options)).rejects.toMatchObject({ reason: "QUOTA" });
    expect(await readdir(f.store.paths.staging)).toEqual([]);
  });
  it("stops and removes partial staging if filesystem space disappears during streaming", async () => {
    const f = await fixture(); const input = await f.source("file", Buffer.alloc(200000)); let checked = false;
    const actual = fs.statfsSync(f.store.paths.staging, { bigint: true });
    f.options.fault = (point) => {
      if (point === "before-write" && !checked) { checked = true; vi.spyOn(fs, "statfsSync").mockReturnValue({ ...actual, bavail: 0n } as never); syncBuiltinESMExports(); }
    };
    await expect(stageUploadFiles(f.store, [input], f.options)).rejects.toMatchObject({ reason: "QUOTA" });
    expect(checked).toBe(true); expect(await readdir(f.store.paths.staging)).toEqual([]);
  });
  it("times out streaming locally and releases its capacity", async () => {
    const f = await fixture(); const input = await f.source();
    f.options.limits.transferTimeoutMs = 1;
    f.options.fault = async (point) => { if (point === "before-write") await setTimeout(20); };
    await expect(stageUploadFiles(f.store, [input], f.options)).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(await readdir(f.store.paths.staging)).toEqual([]);
  });
  it("refuses staging under the current project even if XDG data was misconfigured", async () => {
    const f = await fixture(); const input = await f.source();
    const store = new ChangeStore(join(f.location, "state")); stores.push(store);
    await expect(stageUploadFiles(store, [input], f.options)).rejects.toMatchObject({ reason: "UNSAFE_PATH" });
    expect(f.options.authorizeRead).not.toHaveBeenCalled();
  });
  it.each(["write", "grow", "shrink", "replace", "ancestor"])("rejects source %s during copying and rolls back only its own staging", async (kind) => {
    const f = await fixture(); const input = await f.source("file", "123456");
    await writeFile(join(f.store.paths.staging, "keep"), "keep", { mode: 0o600 });
    f.options.fault = async (point) => {
      if (point !== "after-copy") return;
      if (kind === "replace") { await rm(input.path); await writeFile(input.path, "123456"); }
      else if (kind === "ancestor") await rename(f.exports, join(f.location, "moved"));
      else await writeFile(input.path, kind === "grow" ? "1234567" : kind === "shrink" ? "123" : "abcdef");
    };
    await expect(stageUploadFiles(f.store, [input], f.options)).rejects.toBeInstanceOf(Error);
    expect(await readdir(f.store.paths.staging)).toEqual(["keep"]);
  });
  it.each(["ENOSPC", "EIO"])("cleans up injected %s and releases the reservation for a later attempt", async (code) => {
    const f = await fixture({ limits: { stagingBytes: 10 } }); const input = await f.source("file", "123456");
    f.options.fault = (point) => { if (point === "before-write") throw Object.assign(new Error("synthetic disk failure"), { code }); };
    await expect(stageUploadFiles(f.store, [input], f.options)).rejects.toMatchObject({ reason: "IO" });
    expect(f.store.usage().stagingBytes).toBe(0);
    await expect(stageUploadFiles(f.store, [input], { ...f.options, fault: undefined })).resolves.toHaveLength(1);
  });
  it("rolls back the whole batch when syncing the second file fails", async () => {
    const f = await fixture(); const input = await f.source();
    f.options.fault = (point, index) => { if (point === "before-sync" && index === 1) throw new Error("synthetic EIO"); };
    await expect(stageUploadFiles(f.store, [input, input], f.options)).rejects.toMatchObject({ reason: "IO" });
    expect(await readdir(f.store.paths.staging)).toEqual([]);
  });
  it("propagates native cancellation during a copy and removes the partial file", async () => {
    const f = await fixture(); const input = await f.source(); const abort = new AbortController(); const original = new Error("native abort");
    f.options.signal = abort.signal; f.options.fault = () => { abort.abort(original); };
    await expect(stageUploadFiles(f.store, [input], f.options)).rejects.toBe(original);
    expect(await readdir(f.store.paths.staging)).toEqual([]);
  });
  it("propagates loss of context at completion and removes the whole batch", async () => {
    const f = await fixture(); const input = await f.source(); const original = new Error("session lost"); let calls = 0;
    f.options.revalidateContext = async () => { if (++calls === 2) throw original; };
    await expect(stageUploadFiles(f.store, [input], f.options)).rejects.toBe(original);
    expect(await readdir(f.store.paths.staging)).toEqual([]);
  });
  it.each(["altered", "missing"])("blocks use of %s staging without reopening the original", async (kind) => {
    const f = await fixture(); const input = await f.source(); const files = await stageUploadFiles(f.store, [input], f.options);
    const path = join(f.store.paths.staging, files[0]!.stagedRef);
    const plan = planFixture({ kind: "upload", audience: "ticket", files, steps: [{ id: "step-1", kind: "mutation", fileRefs: [files[0]!.stagedRef] }] });
    f.store.prepare(plan); f.store.claim(plan.id, 0);
    if (kind === "altered") await writeFile(path, "modified"); else await rm(path);
    expect(() => f.store.sending(plan.id, 1, "step-1")).toThrow();
    expect(f.store.get(plan.id).execution.steps[0]!.state).toBe("pending");
  });
  it.each(["copying", "copied"])("preserves and accounts for unassociated bytes after SIGKILL at %s", async (checkpoint) => {
    const f = await fixture(); const input = await f.source("file", Buffer.alloc(200000)); f.store.close();
    const child = fork(fileURLToPath(new URL("../fixtures/staging-worker.mjs", import.meta.url)), [f.data, f.location, input.path, checkpoint], {
      // Runtimes before 26 accept the transform flag for TypeScript workers; 26 removed it and the loader transforms instead.
      execArgv: [...(Number(process.versions.node.split(".")[0]!) < 26 ? ["--experimental-transform-types"] : []), "--experimental-loader", fileURLToPath(new URL("../fixtures/state-loader.mjs", import.meta.url))],
      env: {}, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    const message = await new Promise((resolve, reject) => {
      let stderr = ""; child.stderr!.on("data", (value) => { stderr += String(value); });
      child.once("error", reject); child.once("exit", () => reject(new Error(`Worker exited before checkpoint: ${stderr}`))); child.once("message", resolve);
    });
    expect(message).toEqual({ checkpoint, node: process.version });
    await kill(child);
    const reopened = new ChangeStore(f.data); stores.push(reopened);
    expect(reopened.usage().stagingBytes).toBe(checkpoint === "copying" ? 65536 : 200000);
    expect(reopened.diagnostics()).toEqual({ prepared: 0, applying: 0, applied: 0, failed: 0, unknown: 0 });
    expect(reopened.collect("2026-12-30T00:00:00Z")).toEqual([]);
    expect(await readdir(reopened.paths.staging)).toHaveLength(1);
  });
});
