import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJSON, PersistencePrototype, planHash, PrototypeError } from "../prototypes/persistence.js";
import { now, syntheticPlan } from "../prototypes/fixtures.js";

const directories: string[] = [];
const stores: PersistencePrototype[] = [];
const children: ChildProcess[] = [];
async function directory(): Promise<string> {
  const path = await mkdtemp("/tmp/opencode/jira-persistence-");
  directories.push(path);
  return path;
}
function open(path: string, fault?: ConstructorParameters<typeof PersistencePrototype>[1]): PersistencePrototype {
  const store = new PersistencePrototype(path, fault);
  stores.push(store);
  return store;
}
function worker(path: string, checkpoint: string): ChildProcess {
  const child = fork(fileURLToPath(new URL("../prototypes/worker.mjs", import.meta.url)), [path, checkpoint], {
    execArgv: ["--experimental-strip-types"], env: {}, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.push(child);
  return child;
}
async function ready(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr!.on("data", (value) => { stderr += String(value); });
    child.once("error", reject);
    const exited = () => reject(new Error(`Worker exited before checkpoint: ${stderr}`));
    child.once("exit", exited);
    child.once("message", (value) => { child.removeListener("exit", exited); resolve(value); });
  });
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("[VIA-01][EST-03][PR-03] bounded canonical plans (synthetic)", () => {
  it("ignores object key order, preserves array order and exact Unicode source", () => {
    expect(canonicalJSON({ b: 2, a: ["á\r\n😀", null] })).toBe(canonicalJSON({ a: ["á\r\n😀", null], b: 2 }));
    expect(canonicalJSON([1, 2])).not.toBe(canonicalJSON([2, 1]));
    expect(planHash(syntheticPlan())).toBe(planHash(syntheticPlan()));
  });
  it.each([undefined, NaN, Infinity, 1n, new Date(), new Map(), [, 1], { x: undefined }])("rejects non-JSON input %#", (value) => {
    expect(() => canonicalJSON(value)).toThrow(PrototypeError);
  });
  it("rejects cycles, symbols, getters and resource exhaustion without evaluating getters", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    let evaluated = false;
    const getter = Object.defineProperty({}, "secret", { enumerable: true, get() { evaluated = true; return "secret"; } });
    for (const value of [cycle, getter, { [Symbol()]: 1 }, "a".repeat(1024 * 1024 + 1), Array(10001).fill(1)]) expect(() => canonicalJSON(value)).toThrow();
    expect(evaluated).toBe(false);
  });
  it.each(["sessionID", "locationID", "account", "site", "credentialIdentity", "issueId", "issueKey", "policyFingerprint", "expectedUpdated", "createdAt", "expiresAt", "change", "steps"] as const)("covers %s with the hash", (key) => {
    const plan = syntheticPlan();
    expect(planHash({ ...plan, [key]: "different" })).not.toBe(planHash(plan));
  });
});

describe("[VIA-01][PR-09–PR-11][RC-04][RC-10] durable ownership and CAS (synthetic)", () => {
  it("persists detached plans and rejects duplicate IDs without replacing the approved hash", async () => {
    const path = await directory();
    const store = open(path);
    const plan = syntheticPlan();
    const prepared = store.prepare(plan);
    plan.change = { altered: true };
    prepared.plan.change = { altered: true };
    expect(store.get(plan.id).plan).toEqual(syntheticPlan());
    expect(() => store.prepare(plan)).toThrow(/CONFLICT/);
    store.close();
    const reopened = open(path).get(plan.id);
    expect(reopened.payloadHash).toBe(planHash(syntheticPlan()));
    expect(reopened.execution.state).toBe("prepared");
    expect((await lstat(join(path, "state.sqlite"))).mode & 0o777).toBe(0o600);
  });
  it("atomically claims once and rejects stale revisions", async () => {
    const store = open(await directory());
    store.prepare(syntheticPlan());
    const results = await Promise.allSettled([0, 0].map(async (revision) => store.claim("proposal-1", revision, now)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(store.get("proposal-1").execution.revision).toBe(1);
    expect(() => store.sending("proposal-1", 0, "step-1", now)).toThrow(/CONFLICT/);
  });
  it("serializes the canonical ticket across aliases, but not unrelated sites", async () => {
    const store = open(await directory());
    for (const plan of [syntheticPlan(), syntheticPlan({ id: "alias-plan", account: "another-alias" }), syntheticPlan({ id: "other-site", site: "https://other.invalid" })]) store.prepare(plan);
    store.claim("proposal-1", 0, now);
    expect(() => store.claim("alias-plan", 0, now)).toThrow(/BUSY/);
    expect(store.claim("other-site", 0, now).execution.state).toBe("applying");
  });
  it("keeps an uncertain ticket claimed across restart, expiry and aliases", async () => {
    const path = await directory();
    const store = open(path);
    store.prepare(syntheticPlan()); store.claim("proposal-1", 0, now);
    store.close();
    const recovered = open(path);
    recovered.prepare(syntheticPlan({ id: "alias-plan", account: "other-alias" }));
    expect(() => recovered.claim("alias-plan", 0, now)).toThrow(/BUSY/);
    expect(recovered.get("proposal-1").execution.state).toBe("unknown");
    expect(() => recovered.claim("proposal-1", 2, "2026-11-18T00:00:00.000Z")).toThrow(/CONFLICT/);
  });
  it("excludes a second live process and releases ownership on a clean close", async () => {
    const path = await directory();
    const child = worker(path, "hold");
    expect(await ready(child)).toEqual({ checkpoint: "hold" });
    expect(() => open(path)).toThrow(/BUSY/);
    const exited = once(child, "exit");
    child.send("close");
    await exited;
    expect(open(path)).toBeInstanceOf(PersistencePrototype);
  });
  it("does not steal ownership or alter state when another process tries to open it", async () => {
    const path = await directory();
    const store = open(path);
    store.prepare(syntheticPlan());
    const child = worker(path, "hold");
    expect(await ready(child)).toEqual({ error: "BUSY" });
    expect(store.claim("proposal-1", 0, now).execution.state).toBe("applying");
  });
  it.each(["claimed", "sending", "accepted", "confirmed", "verified"])("recovers after SIGKILL at %s without replaying a synthetic side effect", async (checkpoint) => {
    const path = await directory();
    const child = worker(path, checkpoint);
    expect(await ready(child)).toEqual({ checkpoint });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const store = open(path);
    const result = store.get("proposal-1");
    expect(result.payloadHash).toBe(planHash(syntheticPlan()));
    expect(result.execution.state).toBe(checkpoint === "verified" ? "applied" : "unknown");
    const stepState = { claimed: "pending", sending: "unknown", accepted: "unknown", confirmed: "confirmed", verified: "confirmed" }[checkpoint];
    expect(result.execution.steps[0]!.state).toBe(stepState);
    expect(() => store.claim("proposal-1", result.execution.revision, now)).toThrow(/CONFLICT/);
    expect(() => store.sending("proposal-1", result.execution.revision, "step-1", now)).toThrow(/CONFLICT/);
    const ledger = await readFile(join(path, "synthetic-remote-ledger"), "utf8").catch(() => "");
    expect(ledger).toBe(["accepted", "confirmed", "verified"].includes(checkpoint) ? "synthetic-step-1\n" : "");
    if (["confirmed", "verified"].includes(checkpoint)) expect(result.receipts["step-1"]!.remoteIds).toEqual(["remote-1"]);
    store.close();
    expect(open(path).get("proposal-1")).toEqual(result);
  });
  it.each(["crash-prepare", "crash-sending"])("rolls back an uncommitted transaction after %s", async (checkpoint) => {
    const path = await directory();
    const child = worker(path, checkpoint);
    const [, signal] = await once(child, "exit");
    expect(signal).toBe("SIGKILL");
    const store = open(path);
    if (checkpoint === "crash-prepare") expect(() => store.get("proposal-1")).toThrow(/CONFLICT/);
    else {
      const result = store.get("proposal-1");
      expect(result.execution.state).toBe("unknown");
      expect(result.execution.steps[0]!.state).toBe("pending");
      expect(store.events("proposal-1").map((event) => event.event)).toEqual(["prepared", "claimed", "recovered-unknown"]);
    }
  });
  it("never acknowledges sending when persistence fails before commit", async () => {
    let fail = false;
    const store = open(await directory(), () => { if (fail) throw new Error("synthetic disk failure"); });
    store.prepare(syntheticPlan()); store.claim("proposal-1", 0, now);
    fail = true;
    let syntheticSends = 0;
    expect(() => {
      store.sending("proposal-1", 1, "step-1", now);
      syntheticSends++;
    }).toThrow(/STORAGE/);
    expect(syntheticSends).toBe(0);
    expect(store.get("proposal-1").execution.steps[0]!.state).toBe("pending");
    expect(store.events("proposal-1")).toHaveLength(2);
  });
  it("retains sending uncertainty when persisting a remote confirmation fails", async () => {
    const path = await directory();
    let fail = false;
    const store = open(path, () => { if (fail) throw new Error("synthetic disk failure"); });
    store.prepare(syntheticPlan()); store.claim("proposal-1", 0, now); store.sending("proposal-1", 1, "step-1", now);
    fail = true;
    expect(() => store.confirm("proposal-1", 2, "step-1", { remoteIds: ["remote-1"], temporaryAttachmentIds: [], confirmedAt: now })).toThrow(/STORAGE/);
    expect(store.get("proposal-1").execution.steps[0]!.state).toBe("sending");
    expect(store.get("proposal-1").receipts).toEqual({});
    store.close();
    const recovered = open(path);
    expect(recovered.get("proposal-1").execution.steps[0]!.state).toBe("unknown");
    expect(() => recovered.sending("proposal-1", 3, "step-1", now)).toThrow(/CONFLICT/);
  });
});

describe("[VIA-01][RC-05–RC-08][UP-10] receipts, partial progress and expiry (synthetic)", () => {
  it("requires confirmation and verification, preserving partial receipts across reopen", async () => {
    const path = await directory();
    const store = open(path);
    const plan = syntheticPlan({ steps: [
      { id: "temporary", kind: "temporary-upload", fileRefs: ["file-1"] },
      { id: "publish", kind: "publish-attachments", fileRefs: ["file-1"] },
    ] });
    store.prepare(plan); store.claim(plan.id, 0, now);
    expect(() => store.sending(plan.id, 1, "publish", now)).toThrow(/CONFLICT/);
    store.sending(plan.id, 1, "temporary", now);
    store.confirm(plan.id, 2, "temporary", { remoteIds: [], temporaryAttachmentIds: ["temporary-1"], confirmedAt: now });
    expect(() => store.sending(plan.id, 3, "publish", now)).toThrow(/CONFLICT/);
    store.verified(plan.id, 3, "temporary", now);
    store.sending(plan.id, 4, "publish", now);
    store.close();
    const result = open(path).get(plan.id);
    expect(result.payloadHash).toBe(planHash(plan));
    expect(result.execution.state).toBe("unknown");
    expect(result.execution.steps.map((step) => step.state)).toEqual(["confirmed", "unknown"]);
    expect(result.receipts.temporary!.temporaryAttachmentIds).toEqual(["temporary-1"]);
  });
  it("does not mark an accepted mutation applied before verification; receipts survive TTL", async () => {
    const path = await directory();
    const store = open(path);
    store.prepare(syntheticPlan()); store.claim("proposal-1", 0, now); store.sending("proposal-1", 1, "step-1", now);
    expect(() => store.verified("proposal-1", 2, "step-1", now)).toThrow(/CONFLICT/);
    store.confirm("proposal-1", 2, "step-1", { remoteIds: ["remote-1"], temporaryAttachmentIds: [], confirmedAt: now });
    expect(store.get("proposal-1").execution.state).toBe("applying");
    store.close();
    const recovered = open(path);
    const revision = recovered.get("proposal-1").execution.revision;
    const result = recovered.verified("proposal-1", revision, "step-1", "2026-11-18T00:00:00.000Z");
    expect(result.execution.state).toBe("applied");
    expect(result.receipts["step-1"]!.remoteIds).toEqual(["remote-1"]);
    expect(() => recovered.claim("proposal-1", result.execution.revision, "2026-11-18T00:00:00.000Z")).toThrow(/CONFLICT/);
    expect(recovered.get("proposal-1")).toEqual(result);
  });
  it("blocks claiming and starting steps at expiry without deleting the plan", async () => {
    const store = open(await directory());
    const plan = syntheticPlan(); store.prepare(plan);
    expect(() => store.claim(plan.id, 0, plan.expiresAt)).toThrow(/EXPIRED/);
    store.claim(plan.id, 0, now);
    expect(() => store.sending(plan.id, 1, "step-1", plan.expiresAt)).toThrow(/EXPIRED/);
    expect(store.get(plan.id).payloadHash).toBe(planHash(plan));
  });
  it("stores audit events without change content or credential material", async () => {
    const store = open(await directory());
    store.prepare(syntheticPlan()); store.claim("proposal-1", 0, now);
    expect(store.events("proposal-1")).toEqual([{ revision: 0, event: "prepared" }, { revision: 1, event: "claimed" }]);
    expect(JSON.stringify(store.events("proposal-1"))).not.toMatch(/Texto|identity|token|source/);
  });
});

describe("[VIA-01][EST-01][OP-05] fail-closed local storage (synthetic)", () => {
  it("rejects public directories and symlink roots", async () => {
    const path = await directory();
    await chmod(path, 0o755);
    expect(() => open(path)).toThrow(/UNSAFE_PATH/);
    await chmod(path, 0o700);
    const parent = await directory();
    await symlink(path, join(parent, "linked"));
    expect(() => open(join(parent, "linked"))).toThrow(/UNSAFE_PATH/);
  });
  it.each(["symlink", "hardlink", "public-file", "sidecar"])("rejects %s without replacing existing data", async (variant) => {
    const path = await directory();
    const target = join(await directory(), "sentinel");
    await writeFile(target, "do not modify", { mode: 0o600 });
    if (variant === "symlink") await symlink(target, join(path, "state.sqlite"));
    if (variant === "hardlink") await link(target, join(path, "state.sqlite"));
    if (variant === "public-file") await writeFile(join(path, "state.sqlite"), "invalid", { mode: 0o644 });
    if (variant === "sidecar") await symlink(target, join(path, "state.sqlite-journal"));
    expect(() => open(path)).toThrow(PrototypeError);
    expect(await readFile(target, "utf8")).toBe("do not modify");
  });
  it.each(["hash", "version", "journal-mode", "missing-execution", "missing-table", "empty", "garbage"])("retains and blocks corrupt/incompatible state: %s", async (variant) => {
    const path = await directory();
    const store = open(path); store.prepare(syntheticPlan()); store.close();
    const statePath = join(path, "state.sqlite");
    if (["empty", "garbage"].includes(variant)) await writeFile(statePath, variant === "empty" ? "" : "not a database");
    else {
      const db = new DatabaseSync(statePath);
      try {
        if (variant === "hash") db.exec("UPDATE plans SET hash='corrupted'");
        if (variant === "version") db.exec("PRAGMA user_version=999");
        if (variant === "journal-mode") db.exec("PRAGMA journal_mode=WAL");
        if (variant === "missing-execution") db.exec("DELETE FROM executions");
        if (variant === "missing-table") db.exec("DROP TABLE receipts");
      } finally { db.close(); }
    }
    const bytes = await readFile(statePath);
    expect(() => open(path)).toThrow(/CORRUPT/);
    expect(await readFile(statePath)).toEqual(bytes);
    expect(() => open(path)).toThrow(/CORRUPT/);
  });
  it("rejects unknown structural fields, invalid TTL and duplicate step IDs before persistence", async () => {
    const store = open(await directory());
    for (const input of [
      { ...syntheticPlan(), confirmed: true },
      syntheticPlan({ expiresAt: now }),
      syntheticPlan({ steps: [syntheticPlan().steps[0]!, syntheticPlan().steps[0]!] }),
    ]) expect(() => store.prepare(input)).toThrow(/INVALID/);
    expect(() => store.get("proposal-1")).toThrow(/CONFLICT/);
  });
});
