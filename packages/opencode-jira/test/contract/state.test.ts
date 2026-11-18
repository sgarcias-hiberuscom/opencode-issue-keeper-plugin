import Database from "better-sqlite3";
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJSON, planHash, validatePlan, type ChangePlan } from "../../src/core/proposals.js";
import { ChangeStore, statePolicy, type StoreOptions } from "../../src/state/store.js";
import { StateError, type StateFailure } from "../../src/state/errors.js";
import { statePaths, userDataDirectory } from "../../src/state/paths.js";
import { withChangeStore } from "../../src/state/coordinator.js";
import { instant, planFixture } from "../state-fixtures.js";

const roots: string[] = [];
const stores: ChangeStore[] = [];
const children: ChildProcess[] = [];
async function root(): Promise<string> { const path = await mkdtemp("/tmp/opencode/jira-state-"); roots.push(path); return path; }
function open(data: string, options: StoreOptions = {}): ChangeStore {
  const store = new ChangeStore(data, { now: () => new Date(instant), ...options }); stores.push(store); return store;
}
function failure(callback: () => unknown, reason: StateFailure): void {
  try { callback(); expect.fail("Expected a state failure"); } catch (error) { expect(error).toBeInstanceOf(StateError); expect(error).toMatchObject({ reason }); }
}
function worker(data: string, checkpoint: string): ChildProcess {
  const child = fork(fileURLToPath(new URL("../fixtures/state-worker.mjs", import.meta.url)), [data, checkpoint], {
    execArgv: ["--experimental-strip-types", "--experimental-loader", fileURLToPath(new URL("../fixtures/state-loader.mjs", import.meta.url))],
    env: {}, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.push(child); return child;
}
function ready(child: ChildProcess): Promise<any> {
  return new Promise((resolve, reject) => {
    let stderr = ""; child.stderr!.on("data", (value) => { stderr += String(value); });
    child.once("error", reject);
    const exited = () => reject(new Error(`Worker exited before checkpoint: ${stderr}`));
    child.once("exit", exited);
    child.once("message", (value) => { child.removeListener("exit", exited); resolve(value); });
  });
}
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
}
async function filePlan(store: ChangeStore, id: string, size: number, overrides: Partial<ChangePlan> = {}): Promise<ChangePlan> {
  const bytes = Buffer.alloc(size, 65);
  const stagedRef = `file-${id}`;
  await writeFile(join(store.paths.staging, stagedRef), bytes, { mode: 0o600, flag: "wx" });
  return planFixture({ id, kind: "upload", audience: "ticket", files: [{ stagedRef, publishedName: "prueba.bin", size, sha256: createHash("sha256").update(bytes).digest("hex") }], steps: [{ id: "step-1", kind: "mutation", fileRefs: [stagedRef] }], ...overrides });
}
function applied(store: ChangeStore, plan: ChangePlan): void {
  store.prepare(plan); store.claim(plan.id, 0); store.sending(plan.id, 1, "step-1");
  store.confirm(plan.id, 2, "step-1", { remoteIds: ["remote:1"], temporaryAttachmentIds: [], confirmedAt: instant });
  store.verified(plan.id, 3, "step-1");
}
afterEach(async () => {
  for (const child of children.splice(0)) await stopChild(child);
  for (const store of stores.splice(0)) store.close();
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("[CON-01][EST-03][PR-03] immutable production plan contract", () => {
  it("canonicalizes key order without changing exact text, ranges or array order", () => {
    expect(canonicalJSON({ b: 2, a: "😀\r\n" })).toBe(canonicalJSON({ a: "😀\r\n", b: 2 }));
    expect(canonicalJSON([1, 2])).not.toBe(canonicalJSON([2, 1]));
    expect(planHash(planFixture())).toBe(planHash(validatePlan(planFixture())));
  });
  it.each([undefined, NaN, 1n, new Date(), new Map(), [, 1], { x: undefined }])("rejects non-JSON values %#", (input) => { expect(() => canonicalJSON(input)).toThrow(); });
  it("rejects cycles, getters, deep/large documents without invoking getters", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    let called = false;
    const getter = Object.defineProperty({}, "secret", { enumerable: true, get() { called = true; return "secret"; } });
    for (const input of [cyclic, getter, Array(10001).fill(1), "x".repeat(1024 * 1024 + 1)]) expect(() => canonicalJSON(input)).toThrow();
    expect(called).toBe(false);
  });
  it.each(["id", "sessionID", "locationID", "account", "site", "credentialIdentity", "issueId", "issueKey", "policyFingerprint", "payload", "steps", "expiresAt"] as const)("includes %s in the approval hash", (key) => {
    const plan = planFixture(); expect(planHash({ ...plan, [key]: "different" })).not.toBe(planHash(plan));
  });
  it("requires source/format/audience for comments and rejects unknown approval fields", () => {
    for (const input of [planFixture({ kind: "comment" }), { ...planFixture(), confirmed: true }, planFixture({ kind: "upload" }), planFixture({ expectedUpdated: "yesterday" }), planFixture({ expiresAt: instant })]) expect(() => validatePlan(input)).toThrow();
    expect(validatePlan(planFixture({ kind: "comment", audience: "internal", commentText: "Hola", commentFormat: "plain" }))).toBeDefined();
  });
});

describe("[D-03/D-04][EST-01–EST-04][PR-09–PR-11] global durable store", () => {
  it("uses user/XDG data independent of project cwd and immutable package copies", () => {
    expect(userDataDirectory({ HOME: "/home/example" })).toBe("/home/example/.local/share/issuekeeper/opencode-jira");
    expect(userDataDirectory({ HOME: "/home/example", XDG_DATA_HOME: "/data" })).toBe("/data/issuekeeper/opencode-jira");
    expect(statePaths("/data/issuekeeper/opencode-jira").directory).toBe("/data/issuekeeper/opencode-jira/runtime");
    expect(() => userDataDirectory({ HOME: "/home/example", XDG_DATA_HOME: "relative" })).toThrow();
  });
  it("persists detached plans/receipts and returns a confirmed result without sending after TTL", async () => {
    const data = await root(); const store = open(data); const plan = planFixture(); applied(store, plan);
    const result = store.get(plan.id); result.plan.payload = { changed: true };
    expect(store.get(plan.id).plan).toEqual(plan);
    store.close();
    const reopened = open(data, { now: () => new Date("2026-11-18T12:00:00Z") });
    expect(reopened.get(plan.id).execution.state).toBe("applied");
    expect(reopened.get(plan.id).receipts["step-1"]!.remoteIds).toEqual(["remote:1"]);
    failure(() => reopened.claim(plan.id, 4), "CONFLICT");
    expect((await lstat(reopened.paths.database)).mode & 0o777).toBe(0o600);
  });
  it("rejects duplicate IDs, stale revisions and already claimed canonical tickets across aliases", async () => {
    const store = open(await root()); const plan = planFixture(); store.prepare(plan);
    failure(() => store.prepare(plan), "CONFLICT"); store.claim(plan.id, 0);
    failure(() => store.claim(plan.id, 0), "CONFLICT");
    store.prepare(planFixture({ id: "alias-plan", account: "other" }));
    failure(() => store.claim("alias-plan", 0), "BUSY");
    store.prepare(planFixture({ id: "site-plan", site: "https://other.invalid" }));
    expect(store.claim("site-plan", 0).execution.state).toBe("applying");
  });
  it("does not drop the OS lock after a rejected same-process open", async () => {
    const data = await root(); open(data);
    failure(() => open(data), "BUSY");
    const child = worker(data, "hold");
    expect(await ready(child)).toEqual({ error: "BUSY" });
  });
  it("excludes a second process and admits a new owner after clean close", async () => {
    const data = await root(); const child = worker(data, "hold");
    expect((await ready(child)).checkpoint).toBe("hold");
    failure(() => open(data), "BUSY");
    const exited = once(child, "exit"); child.send("close"); await exited;
    expect(open(data)).toBeInstanceOf(ChangeStore);
  });
  it.each(["claimed", "sending", "accepted", "confirmed", "verified"])("recovers SIGKILL at %s without replaying the synthetic emitter", async (checkpoint) => {
    const data = await root(); const child = worker(data, checkpoint);
    const reached = await ready(child);
    expect(reached.checkpoint).toBe(checkpoint); expect(reached.node).toBe(process.version);
    await stopChild(child);
    const store = open(data); const result = store.get("proposal-1");
    expect(result.payloadHash).toBe(planHash(planFixture()));
    expect(result.execution.state).toBe(checkpoint === "verified" ? "applied" : "unknown");
    expect(result.execution.steps[0]!.state).toBe(({ claimed: "pending", sending: "unknown", accepted: "unknown", confirmed: "confirmed", verified: "confirmed" })[checkpoint]);
    failure(() => store.claim("proposal-1", result.execution.revision), "CONFLICT");
    failure(() => store.sending("proposal-1", result.execution.revision, "step-1"), "CONFLICT");
    expect(await readFile(join(data, "synthetic-remote-ledger"), "utf8").catch(() => "")).toBe(["accepted", "confirmed", "verified"].includes(checkpoint) ? "synthetic-step-1\n" : "");
    if (["confirmed", "verified"].includes(checkpoint)) expect(result.receipts["step-1"]!.remoteIds).toEqual(["remote:1"]);
  });
  it.each(["crash-prepare", "crash-sending"])("rolls back interrupted transactions at %s", async (checkpoint) => {
    const data = await root(); const child = worker(data, checkpoint);
    expect((await once(child, "exit"))[1]).toBe("SIGKILL");
    const store = open(data);
    if (checkpoint === "crash-prepare") failure(() => store.get("proposal-1"), "NOT_FOUND");
    else { expect(store.get("proposal-1").execution.state).toBe("unknown"); expect(store.get("proposal-1").execution.steps[0]!.state).toBe("pending"); }
  });
  it("prevents sending when the preceding journal commit fails and preserves sending if a receipt commit fails", async () => {
    const data = await root(); let fail = false;
    const store = open(data, { fault: () => { if (fail) throw new Error("synthetic EIO"); } });
    store.prepare(planFixture()); store.claim("proposal-1", 0); fail = true;
    let sends = 0;
    failure(() => { store.sending("proposal-1", 1, "step-1"); sends++; }, "IO");
    expect(sends).toBe(0); expect(store.get("proposal-1").execution.steps[0]!.state).toBe("pending");
    fail = false; store.sending("proposal-1", 1, "step-1"); fail = true;
    failure(() => store.confirm("proposal-1", 2, "step-1", { remoteIds: ["remote-1"], temporaryAttachmentIds: [], confirmedAt: instant }), "IO");
    expect(store.get("proposal-1").execution.steps[0]!.state).toBe("sending");
    store.close(); expect(open(data).get("proposal-1").execution.state).toBe("unknown");
  });
  it("blocks claiming or starting steps at expiry without deleting progress", async () => {
    const store = open(await root()); const plan = planFixture(); store.prepare(plan);
    failure(() => store.claim(plan.id, 0, plan.expiresAt), "EXPIRED");
    store.claim(plan.id, 0); failure(() => store.sending(plan.id, 1, "step-1", plan.expiresAt), "EXPIRED");
    expect(store.get(plan.id).payloadHash).toBe(planHash(plan));
  });
  it("keeps confirmed partial steps and ticket ownership after a later definitive failure", async () => {
    const data = await root(); const store = open(data);
    const plan = planFixture({ steps: [{ id: "step-1", kind: "mutation", fileRefs: [] }, { id: "step-2", kind: "mutation", fileRefs: [] }] });
    store.prepare(plan); store.claim(plan.id, 0); store.sending(plan.id, 1, "step-1");
    store.confirm(plan.id, 2, "step-1", { remoteIds: ["remote-1"], temporaryAttachmentIds: [], confirmedAt: instant });
    store.verified(plan.id, 3, "step-1"); store.stop(plan.id, 4, "step-2", "failed");
    expect(store.collect("2026-12-17T10:00:00Z")).toEqual([]);
    failure(() => store.assertMaintenanceSafe(), "BUSY");
    store.close(); const reopened = open(data); expect(reopened.get(plan.id).receipts["step-1"]!.remoteIds).toEqual(["remote-1"]);
    reopened.prepare(planFixture({ id: "alias-plan", account: "other" })); failure(() => reopened.claim("alias-plan", 0), "BUSY");
  });
});

describe("[EST-05][D-04/D-12/D-14][RC-08][UP-10] approved retention and pressure policy", () => {
  it("uses seven days for terminal results and 24 hours after expiry for never-sent plans", async () => {
    const store = open(await root()); applied(store, planFixture());
    store.prepare(planFixture({ id: "expired" }));
    expect(store.collect("2026-11-18T10:09:59Z")).toEqual([]);
    expect(store.collect("2026-11-18T10:10:00Z")).toEqual(["expired"]);
    expect(store.collect("2026-11-24T09:59:59Z")).toEqual([]);
    expect(store.collect("2026-11-24T10:00:00Z")).toEqual(["proposal-1"]);
    failure(() => store.get("proposal-1"), "NOT_FOUND");
  });
  it("under pressure removes the oldest eligible terminal/expired records before their normal deadline", async () => {
    let clock = instant;
    const store = open(await root(), { now: () => new Date(clock), limits: { stagingBytes: 600 } });
    const done = await filePlan(store, "done", 100); applied(store, done);
    const expired = await filePlan(store, "expired", 100); store.prepare(expired);
    const active = await filePlan(store, "active", 100, { issueId: "other", expiresAt: "2026-11-18T10:00:00Z" }); store.prepare(active); store.claim(active.id, 0);
    clock = "2026-11-17T11:00:00Z";
    const incoming = await filePlan(store, "incoming", 500, { createdAt: clock, expiresAt: "2026-11-17T11:10:00Z" });
    expect(store.prepare(incoming).execution.state).toBe("prepared");
    failure(() => store.get(done.id), "NOT_FOUND"); failure(() => store.get(expired.id), "NOT_FOUND");
    expect(await readFile(join(store.paths.staging, active.files[0]!.stagedRef))).toHaveLength(100);
    expect(await readFile(join(store.paths.staging, done.files[0]!.stagedRef)).catch(() => null)).toBeNull();
    expect(await readFile(join(store.paths.staging, expired.files[0]!.stagedRef)).catch(() => null)).toBeNull();
    expect(store.usage().stagingBytes).toBe(600);
    expect(store.get(active.id).execution.state).toBe("applying");
  });
  it("orders both eligible sets by age without preferring the record kind", async () => {
    let clock = instant;
    const store = open(await root(), { now: () => new Date(clock) });
    store.prepare(planFixture({ id: "expired-first", expiresAt: "2026-11-17T10:01:00Z" }));
    clock = "2026-11-17T10:02:00Z";
    applied(store, planFixture({ id: "done-second" }));
    const current = store.get("done-second");
    expect(current.execution.state).toBe("applied");
    expect(store.collect("2026-11-25T10:00:00Z")).toEqual(["expired-first", "done-second"]);
  });
  it("does not evict active, partial, unknown or unexpired plans when quota cannot be satisfied", async () => {
    const store = open(await root(), { limits: { stagingBytes: 200 } });
    const plan = await filePlan(store, "protected", 100); store.prepare(plan); store.claim(plan.id, 0); store.sending(plan.id, 1, "step-1"); store.stop(plan.id, 2, "step-1", "unknown");
    const incoming = await filePlan(store, "incoming", 200);
    failure(() => store.prepare(incoming), "QUOTA");
    expect(store.get(plan.id).execution.state).toBe("unknown"); expect(store.usage().stagingBytes).toBe(300);
    expect(store.collect("2026-12-30T00:00:00Z")).toEqual([]);
  });
  it("reclaims space in SQLite's freelist instead of deleting/recreating the database", async () => {
    const store = open(await root(), { limits: { databaseBytes: 320 * 1024, reserveBytes: 32768 } });
    applied(store, planFixture({ payload: { text: "a".repeat(100000) } }));
    const inode = (await lstat(store.paths.database)).ino;
    const plan = planFixture({ id: "new", payload: { text: "b".repeat(100000) } });
    expect(store.prepare(plan).plan.id).toBe("new");
    failure(() => store.get("proposal-1"), "NOT_FOUND");
    expect((await lstat(store.paths.database)).ino).toBe(inode);
  });
  it("does not delete altered staging or unrelated files as part of garbage collection", async () => {
    const store = open(await root()); const plan = await filePlan(store, "done", 100); applied(store, plan);
    const path = join(store.paths.staging, plan.files[0]!.stagedRef); await writeFile(path, Buffer.alloc(100, 66));
    const unrelated = join(store.paths.staging, "unrelated"); await writeFile(unrelated, "keep", { mode: 0o600 });
    failure(() => store.collect("2026-11-25T10:00:00Z"), "CORRUPT");
    expect(await readFile(path)).toEqual(Buffer.alloc(100, 66)); expect(await readFile(unrelated, "utf8")).toBe("keep");
  });
  it("resumes committed staging cleanup after a crash boundary without recreating the retired plan", async () => {
    const data = await root(); let fail = false;
    const store = open(data, { fault: (point) => { if (fail && point === "after-retention-commit") throw new Error("synthetic interruption"); } });
    const plan = await filePlan(store, "done", 100); applied(store, plan); fail = true;
    failure(() => store.collect("2026-11-25T10:00:00Z"), "IO");
    failure(() => store.get(plan.id), "NOT_FOUND");
    expect(await readFile(join(store.paths.staging, plan.files[0]!.stagedRef))).toHaveLength(100);
    store.close();
    const recovered = open(data); recovered.collect("2026-11-25T10:00:00Z");
    expect(recovered.usage().stagingBytes).toBe(0);
    failure(() => recovered.get(plan.id), "NOT_FOUND");
  });
  it("keeps the approved global quota defaults", () => {
    expect(statePolicy.databaseBytes).toBe(256 * 1024 * 1024); expect(statePolicy.stagingBytes).toBe(512 * 1024 * 1024);
    expect(statePolicy.terminalMs).toBe(7 * 86400_000);
  });
});

describe("[EST-01][OP-05] fail-closed storage", () => {
  it.each(["hash", "version", "plan-version", "missing-execution", "missing-table", "empty", "garbage"])("does not recreate %s state", async (variant) => {
    const data = await root(); const store = open(data); store.prepare(planFixture()); const path = store.paths.database; store.close();
    if (["empty", "garbage"].includes(variant)) await writeFile(path, variant === "empty" ? "" : "garbage");
    else { const db = new Database(path); try {
      if (variant === "hash") db.exec("UPDATE plans SET hash='corrupted'");
      if (variant === "version") db.exec("PRAGMA user_version=999");
      if (variant === "plan-version") db.prepare("UPDATE plans SET document=?").run(JSON.stringify({ ...planFixture(), version: 2 }));
      if (variant === "missing-execution") db.exec("DELETE FROM executions");
      if (variant === "missing-table") db.exec("DROP TABLE receipts");
    } finally { db.close(); } }
    const bytes = await readFile(path);
    failure(() => open(data), ["version", "plan-version", "empty"].includes(variant) ? "INCOMPATIBLE" : "CORRUPT");
    expect(await readFile(path)).toEqual(bytes);
  });
  it.each(["symlink", "hardlink", "public"])("rejects %s database paths", async (variant) => {
    const data = await root(); const store = open(data); const path = store.paths.database; store.close();
    if (variant === "public") await chmod(path, 0o644);
    else {
      const target = join(data, "sentinel"); await writeFile(target, "keep", { mode: 0o600 }); await rm(path);
      if (variant === "symlink") await symlink(target, path); else await link(target, path);
    }
    failure(() => open(data), "UNSAFE_PATH");
  });
});

describe("[CON-03][EST-02][D-13][PR-10] global callback coordination", () => {
  it("shares one store queue across different project contexts and keeps cancellation native", async () => {
    const data = await root(); let release!: () => void; let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const first = withChangeStore(async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); }, { data });
    await enteredPromise;
    const controller = new AbortController(); const original = new Error("native cancellation");
    const second = withChangeStore(() => expect.fail("Cancelled waiter entered"), { data, signal: controller.signal });
    const rejection = expect(second).rejects.toBe(original); controller.abort(original); await rejection;
    await expect(withChangeStore(() => undefined, { data, mode: "maintenance" })).rejects.toMatchObject({ reason: "BUSY" });
    release(); await first;
    await expect(withChangeStore(() => "available", { data })).resolves.toBe("available");
  });
  it("does not release ownership early when a callback's signal is cancelled", async () => {
    const data = await root(); const controller = new AbortController(); let release!: () => void; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const active = withChangeStore(async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); }, { data, signal: controller.signal });
    await started; controller.abort();
    failure(() => open(data), "BUSY");
    release(); await active;
    expect(open(data)).toBeInstanceOf(ChangeStore);
  });
  it("rejects reentrant acquisition instead of deadlocking and releases ownership on errors", async () => {
    const data = await root();
    await withChangeStore(async () => { await expect(withChangeStore(() => undefined, { data })).rejects.toMatchObject({ reason: "BUSY" }); }, { data });
    const original = new Error("callback failed");
    await expect(withChangeStore(() => { throw original; }, { data })).rejects.toBe(original);
    expect(open(data)).toBeInstanceOf(ChangeStore);
  });
});
