import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeApplication, type ChangeContext, type ChangePorts, type ChangeValidation } from "../../src/state/application.js";
import { ChangeStore, type StoreOptions } from "../../src/state/store.js";
import { changeReview } from "../../src/core/review.js";
import { ChangeRuntime } from "../../src/state/runtime.js";
import { instant, planFixture } from "../state-fixtures.js";
import type { ChangePlan } from "../../src/core/proposals.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });
async function fixture(plan: ChangePlan = planFixture(), options: StoreOptions = {}) {
  const data = await mkdtemp("/tmp/opencode/jira-application-"); roots.push(data);
  let clock = instant;
  const storeOptions = { now: () => new Date(clock), ...options };
  const store = new ChangeStore(data, storeOptions);
  for (const file of plan.files) await writeFile(join(store.paths.staging, file.stagedRef), Buffer.alloc(file.size, 65), { mode: 0o600 });
  store.prepare(plan); store.close();
  const abort = new AbortController(); let locationID = plan.locationID;
  const context: ChangeContext = { sessionID: plan.sessionID, signal: abort.signal, resolve: async () => ({ sessionID: context.sessionID, locationID }) };
  const validation: ChangeValidation<string> = { account: plan.account, site: plan.site, credentialIdentity: plan.credentialIdentity, issueId: plan.issueId, issueKey: plan.issueKey, projectKey: plan.projectKey, policyFingerprint: plan.policyFingerprint, updated: plan.expectedUpdated, binding: "ephemeral" };
  let sends = 0;
  const ports: ChangePorts<string> = {
    validate: vi.fn(async () => ({ ...validation })),
    present: vi.fn(async (review) => ({ payloadHash: review.payloadHash, reviewHash: review.reviewHash, complete: true })),
    authorize: vi.fn(async () => {}),
    send: vi.fn<ChangePorts<string>["send"]>(async (_plan, _step, _binding, _context, beforeSend) => {
      await beforeSend(); sends++;
      return { outcome: "confirmed", receipt: { remoteIds: [`remote-${sends}`], temporaryAttachmentIds: [], confirmedAt: instant } };
    }),
    verify: vi.fn(async () => true),
  };
  const app = new ChangeApplication(ports, { data, ...storeOptions });
  function get() { const store = new ChangeStore(data, storeOptions); try { return store.get(plan.id); } finally { store.close(); } }
  return { data, plan, app, ports, context, abort, validation, get, sent: () => sends, clock: (value: string) => { clock = value; }, move: () => { locationID = "0".repeat(64); } };
}
describe("[APL/REV/REC][PR-02–PR-11][RC-01–RC-09] protected offline application", () => {
  it("orders complete review, permission, durable sending, receipt and verification", async () => {
    const f = await fixture(); const order: string[] = [];
    f.ports.present = async (review) => { order.push("review"); expect(review.text).toContain(f.plan.expectedUpdated); expect(review.text).toContain("FIN DE REVISIÓN"); return { ...review, complete: true }; };
    f.ports.authorize = async (review) => { order.push("permission"); expect(review.resource).toContain(review.payloadHash); };
    f.ports.send = async (_plan, _step, _binding, _context, beforeSend) => { order.push("before-send"); await beforeSend(); order.push("send"); return { outcome: "confirmed", receipt: { remoteIds: ["1"], temporaryAttachmentIds: [], confirmedAt: instant } }; };
    f.ports.verify = async () => { order.push("verify"); return true; };
    const result = await f.app.apply(f.plan.id, f.context);
    expect(result.execution.state).toBe("applied"); expect(order).toEqual(["review", "permission", "before-send", "send", "verify"]);
    expect(result.receipts["step-1"]!.verifiedAt).toBe(instant);
  });
  it("returns the durable receipt after TTL without another permission or send", async () => {
    const f = await fixture(); const first = await f.app.apply(f.plan.id, f.context); f.clock("2026-12-01T10:00:00Z");
    expect(await f.app.apply(f.plan.id, f.context)).toEqual(first); expect(f.sent()).toBe(1); expect(f.ports.authorize).toHaveBeenCalledTimes(1);
  });
  it.each(["session", "location"])("blocks a different %s even for confirmed receipt access", async (kind) => {
    const f = await fixture(); await f.app.apply(f.plan.id, f.context);
    if (kind === "session") f.context.sessionID = "different"; else f.move();
    await expect(f.app.apply(f.plan.id, f.context)).rejects.toMatchObject({ code: "FILE_ACCESS_DENIED" }); expect(f.sent()).toBe(1);
  });
  it.each(["account", "site", "credentialIdentity", "issueId", "issueKey", "projectKey", "policyFingerprint", "updated"] as const)("revalidates %s after waiting for permission", async (field) => {
    const f = await fixture(); const hash = changeReview(f.plan).payloadHash;
    f.ports.authorize = async () => { f.validation[field] = field === "updated" ? "2026-11-17T10:00:01Z" : "different"; };
    await expect(f.app.apply(f.plan.id, f.context)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.sent()).toBe(0); expect(f.get().payloadHash).toBe(hash); expect(f.get().execution.state).toBe("failed");
  });
  it.each(["truncated", "different-plan", "different-view"])("blocks %s review even if authorization would allow", async (kind) => {
    const f = await fixture(); f.ports.present = async (review) => ({ payloadHash: kind === "different-plan" ? "x" : review.payloadHash, reviewHash: kind === "different-view" ? "x" : review.reviewHash, complete: kind !== "truncated" });
    await expect(f.app.apply(f.plan.id, f.context)).rejects.toMatchObject({ code: "FORBIDDEN" }); expect(f.sent()).toBe(0); expect(f.ports.authorize).not.toHaveBeenCalled();
  });
  it("propagates native rejection without another operation", async () => {
    const f = await fixture(); const original = new Error("native refusal"); f.ports.authorize = async () => { throw original; };
    await expect(f.app.apply(f.plan.id, f.context)).rejects.toBe(original); expect(f.sent()).toBe(0); expect(f.get().execution.state).toBe("failed");
  });
  it.each(["before-claim", "during-permission"])("blocks expiry %s without sending", async (point) => {
    const f = await fixture(); if (point === "before-claim") f.clock(f.plan.expiresAt); else f.ports.authorize = async () => { f.clock(f.plan.expiresAt); };
    await expect(f.app.apply(f.plan.id, f.context)).rejects.toMatchObject({ reason: "EXPIRED" }); expect(f.sent()).toBe(0);
  });
  it("prevents duplicate sends for two concurrent applications", async () => {
    const f = await fixture(); const results = await Promise.all([f.app.apply(f.plan.id, f.context), f.app.apply(f.plan.id, f.context)]);
    expect(results.map((result) => result.execution.state)).toEqual(["applied", "applied"]); expect(f.sent()).toBe(1);
  });
  it("recovers a confirmed but unverified receipt without resending or requiring the old updated timestamp", async () => {
    const f = await fixture(); f.ports.verify = async () => false;
    const pending = await f.app.apply(f.plan.id, f.context); expect(pending.execution.state).toBe("unknown"); expect(pending.receipts["step-1"]!.remoteIds).toEqual(["remote-1"]);
    f.validation.updated = "2026-11-17T11:00:00Z"; f.clock("2026-12-01T10:00:00Z"); f.ports.verify = async () => true;
    expect((await f.app.verifyConfirmed(f.plan.id, f.context)).execution.state).toBe("applied"); expect(f.sent()).toBe(1);
  });
  it.each(["rejected", "unknown"] as const)("does not replay a %s step when apply is called again", async (outcome) => {
    const f = await fixture(); let sends = 0;
    f.ports.send = async (_plan, _step, _binding, _context, beforeSend) => { await beforeSend(); sends++; return { outcome }; };
    expect((await f.app.apply(f.plan.id, f.context)).execution.state).toBe(outcome === "rejected" ? "failed" : "unknown");
    await f.app.apply(f.plan.id, f.context); expect(sends).toBe(1);
  });
  it("keeps earlier receipts and stops if freshness cannot be proven between phases", async () => {
    const f = await fixture(planFixture({ steps: [{ id: "step-1", kind: "mutation", fileRefs: [] }, { id: "step-2", kind: "mutation", fileRefs: [] }] }));
    f.ports.verify = async () => { f.validation.updated = "2026-11-17T10:00:01Z"; return true; };
    await expect(f.app.apply(f.plan.id, f.context)).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN", retryable: false });
    const result = f.get(); expect(result.execution.state).toBe("unknown"); expect(result.execution.steps.map((step) => step.state)).toEqual(["confirmed", "pending"]); expect(f.sent()).toBe(1);
  });
  it("does not reach the emitter when persisting sending fails", async () => {
    let armed = false;
    const f = await fixture(planFixture(), { fault: () => { if (armed) throw new Error("EIO"); } });
    f.ports.authorize = async () => { armed = true; };
    await expect(f.app.apply(f.plan.id, f.context)).rejects.toMatchObject({ reason: "IO" });
    armed = false; expect(f.sent()).toBe(0); expect(f.get().execution.steps[0]!.state).toBe("pending");
  });
  it("preserves uncertainty if the receipt cannot be committed after sending", async () => {
    let armed = false;
    const f = await fixture(planFixture(), { fault: () => { if (armed) throw new Error("EIO"); } }); let sends = 0;
    f.ports.send = async (_plan, _step, _binding, _context, beforeSend) => { await beforeSend(); sends++; armed = true; return { outcome: "confirmed", receipt: { remoteIds: ["1"], temporaryAttachmentIds: [], confirmedAt: instant } }; };
    await expect(f.app.apply(f.plan.id, f.context)).rejects.toMatchObject({ reason: "IO" });
    armed = false; expect(f.get().execution.state).toBe("unknown"); await f.app.apply(f.plan.id, f.context); expect(sends).toBe(1);
  });
  it("keeps ownership while a cancelled emitter remains in flight", async () => {
    const f = await fixture(); let release!: () => void; let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; }); const original = new Error("native abort");
    f.ports.send = async (_plan, _step, _binding, _context, beforeSend) => { await beforeSend(); started(); await new Promise<void>((resolve) => { release = resolve; }); throw original; };
    const applying = f.app.apply(f.plan.id, f.context); const rejected = expect(applying).rejects.toBe(original); await ready; f.abort.abort(original);
    expect(() => new ChangeStore(f.data)).toThrow(); release(); await rejected;
    expect(f.get().execution.state).toBe("unknown");
  });
  it("waits for in-flight work during runtime cleanup and blocks new admission", async () => {
    const f = await fixture(); const runtime = new ChangeRuntime({ data: f.data, now: () => new Date(instant) });
    let release!: () => void; let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    f.ports.send = async (_plan, _step, _binding, _context, beforeSend) => { await beforeSend(); started(); await new Promise<void>((resolve) => { release = resolve; }); return { outcome: "unknown" }; };
    const task = runtime.apply(f.plan.id, f.context, f.ports); const rejected = expect(task).rejects.toMatchObject({ name: "AbortError" }); await ready;
    let closed = false; const closing = runtime.close().then(() => { closed = true; }); await Promise.resolve();
    expect(closed).toBe(false); expect(() => new ChangeStore(f.data)).toThrow();
    await expect(runtime.apply(f.plan.id, f.context, f.ports)).rejects.toMatchObject({ reason: "CLOSED" });
    release(); await rejected; await closing; expect(closed).toBe(true); expect(f.get().execution.state).toBe("unknown");
  });
  it("abandons a cancelled permission wait without letting a late approval start sending", async () => {
    const f = await fixture(); const runtime = new ChangeRuntime({ data: f.data, now: () => new Date(instant) });
    let decide!: () => void; let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    f.ports.authorize = async () => { started(); await new Promise<void>((resolve) => { decide = resolve; }); };
    const task = runtime.apply(f.plan.id, f.context, f.ports); const rejected = expect(task).rejects.toMatchObject({ name: "AbortError" }); await ready;
    await runtime.close(); await rejected;
    expect(f.get().execution.state).toBe("failed"); decide(); await Promise.resolve(); expect(f.sent()).toBe(0);
  });
  it.each(["location", "expiry", "session-unavailable"])("releases an unresolved approval after %s changes and ignores a late grant", async (cause) => {
    const f = await fixture(); const hash = changeReview(f.plan).payloadHash;
    let decide!: () => void; let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    f.ports.authorize = async () => { started(); await new Promise<void>((resolve) => { decide = resolve; }); };
    const task = f.app.apply(f.plan.id, f.context);
    const original = new Error("server session unavailable");
    const rejected = cause === "session-unavailable" ? expect(task).rejects.toBe(original) : expect(task).rejects.toMatchObject(cause === "location" ? { code: "FILE_ACCESS_DENIED" } : { reason: "EXPIRED" });
    await ready;
    if (cause === "location") f.move();
    if (cause === "expiry") f.clock(f.plan.expiresAt);
    if (cause === "session-unavailable") f.context.resolve = async () => { throw original; };
    await rejected;
    const saved = f.get(); expect(saved.execution.state).toBe("failed"); expect(saved.payloadHash).toBe(hash); expect(saved.receipts).toEqual({});
    expect(saved.execution.steps.every((step) => step.state === "pending")).toBe(true);
    expect(f.ports.validate).toHaveBeenCalledTimes(1); expect(f.sent()).toBe(0);
    decide(); await Promise.resolve(); expect(f.sent()).toBe(0);
  });
  it("clears its approval monitor after completion without continuing scope checks", async () => {
    const f = await fixture(); vi.useFakeTimers();
    try { expect((await f.app.apply(f.plan.id, f.context)).execution.state).toBe("applied"); expect(vi.getTimerCount()).toBe(0); }
    finally { vi.useRealTimers(); }
  });
  it("keeps temporary server IDs in durable progress, not in the approved multifase plan", async () => {
    const file = { stagedRef: "pinned", publishedName: "file.txt", size: 1, sha256: createHash("sha256").update("A").digest("hex") };
    const f = await fixture(planFixture({ kind: "upload", audience: "internal", files: [file], steps: [{ id: "temporary", kind: "temporary-upload", fileRefs: [file.stagedRef] }, { id: "publish", kind: "publish-attachments", fileRefs: [file.stagedRef] }] }));
    const hash = changeReview(f.plan).payloadHash; let sends = 0;
    f.ports.send = async (_plan, step, _binding, _context, beforeSend, progress) => {
      await beforeSend(); sends++;
      if (step.id === "publish") expect(progress.receipts.temporary!.temporaryAttachmentIds).toEqual(["server-temp"]);
      return { outcome: "confirmed", receipt: { remoteIds: step.id === "publish" ? ["published"] : [], temporaryAttachmentIds: step.id === "temporary" ? ["server-temp"] : [], confirmedAt: instant } };
    };
    const result = await f.app.apply(f.plan.id, f.context);
    expect(result.execution.state).toBe("applied"); expect(sends).toBe(2); expect(result.payloadHash).toBe(hash); expect(JSON.stringify(result.plan)).not.toContain("server-temp");
  });
});
