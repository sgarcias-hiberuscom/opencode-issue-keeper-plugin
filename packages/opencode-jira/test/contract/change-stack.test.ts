import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/http.js";
import { JiraChangeAdapter } from "../../src/jira/changes.js";
import { ChangeApplication, type ChangeContext } from "../../src/state/application.js";
import { ChangeStore } from "../../src/state/store.js";
import { statePaths } from "../../src/state/paths.js";
import { inspectProposal, verifyRecorded } from "../../src/state/operator.js";
import { changeReview } from "../../src/core/review.js";
import { changePolicyFingerprint } from "../../src/core/change-policy.js";
import { config, issue, json, mockFetch } from "../helpers.js";
import { planFixture } from "../state-fixtures.js";

const roots: string[] = []; const clients: HttpClient[] = [];
beforeEach(() => vi.stubEnv("IK_TEST_WORK", "synthetic-token"));
afterEach(async () => { vi.unstubAllEnvs(); clients.splice(0).forEach((client) => client.close()); for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });
async function fixture(kind: "fields" | "transition" = "fields", outcome = "success") {
  const data = await mkdtemp("/tmp/opencode/jira-stack-"); roots.push(data);
  const c = config(); const account = c.accounts[0]!; account.readOnly = false; c.http.readMaxAttempts = 1; c.http.maxConcurrentPerAccount = 1;
  let emitted = 0; let verificationFailure = false; let denied = false; let drift = false;
  const remote = issue(); const initial = remote.fields.updated;
  const now = new Date();
  const plan = planFixture({ account: account.id, site: account.siteUrl, credentialIdentity: "person", issueId: remote.id, issueKey: remote.key, projectKey: remote.fields.project.key, kind,
    locationID: createHash("sha256").update(data).digest("hex"), expectedUpdated: initial, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600000).toISOString(), policyFingerprint: changePolicyFingerprint(c, account),
    payload: kind === "fields" ? { request: { kind, issueKey: remote.key, fields: { summary: "nuevo" } }, expectedFields: { summary: "nuevo" } } : { request: { kind, issueKey: remote.key, transitionId: "31" }, expectedFields: {}, expectedStatusId: "4" },
  });
  const fetcher = mockFetch(async (url, init) => {
    if (init.method === "PUT" || init.method === "POST") {
      const db = new Database(statePaths(data).database, { readonly: true });
      try { expect(JSON.parse((db.prepare("SELECT document FROM executions WHERE id=?").get(plan.id) as { document: string }).document).steps[0].state).toBe("sending"); } finally { db.close(); }
      emitted++;
      if (outcome === "429") return json({}, 429);
      if (kind === "fields") remote.fields.summary = "nuevo"; else remote.fields.status.id = "4";
      remote.fields.updated = new Date().toISOString();
      if (outcome === "disconnect") throw new Error("accepted then connection lost");
      if (outcome === "verify-failure") verificationFailure = true;
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/myself")) return json({ accountId: "person", active: true });
    if (url.pathname.endsWith("/mypermissions")) return json({ permissions: { EDIT_ISSUES: { havePermission: true }, TRANSITION_ISSUES: { havePermission: true } } });
    if (url.pathname.endsWith("/editmeta")) return json({ fields: { summary: { name: "Resumen", required: true, schema: { type: "string" }, operations: ["set"] } } });
    if (url.pathname.endsWith("/transitions")) return json({ transitions: [{ id: "31", to: { id: "4" }, fields: {} }] });
    if (verificationFailure) throw new Error("verification unavailable");
    return json(drift ? { ...remote, fields: { ...remote.fields, updated: "2026-11-17T23:59:00Z" } } : remote);
  });
  const http = new HttpClient(c, fetcher); clients.push(http);
  const adapter = new JiraChangeAdapter(() => c, http, async () => {});
  const context: ChangeContext = { sessionID: plan.sessionID, signal: new AbortController().signal, resolve: async () => ({ sessionID: plan.sessionID, locationID: plan.locationID }) };
  const app = new ChangeApplication({ validate: adapter.validate.bind(adapter), send: adapter.send.bind(adapter), verify: adapter.verify.bind(adapter),
    present: async (_review, _context, recorded) => { if (!recorded) throw new Error("review missing"); return recorded; }, authorize: async () => { if (denied) throw new Error("native denied"); },
  }, { data });
  await app.prepare(plan, context);
  const store = new ChangeStore(data); store.acknowledgeReview(plan.id, 0, changeReview(plan).reviewHash); store.close();
  return { data, c, app, plan, context, account, fetcher, emitted: () => emitted, deny: () => { denied = true; }, drift: () => { drift = true; }, recoverVerification: () => { verificationFailure = false; } };
}
describe("[G2][TST-01][APL/HTTP/IDN/MET/REC] integrated durable application stack", () => {
  it.each(["fields", "transition"] as const)("prepares without mutations and applies/verifies %s exactly once", async (kind) => {
    const f = await fixture(kind); expect(f.emitted()).toBe(0);
    const applied = await f.app.apply(f.plan.id, f.context); expect(applied.execution.state).toBe("applied"); expect(f.emitted()).toBe(1);
    await f.app.apply(f.plan.id, f.context); expect(f.emitted()).toBe(1);
  });
  it.each(["429", "disconnect"])("does not replay %s even after reopening durable state", async (outcome) => {
    const f = await fixture("fields", outcome);
    expect((await f.app.apply(f.plan.id, f.context)).execution.state).toBe(outcome === "429" ? "failed" : "unknown");
    await f.app.apply(f.plan.id, f.context); expect(f.emitted()).toBe(1);
  });
  it("keeps a confirmed receipt across a failed verification and completes it by reads alone", async () => {
    const f = await fixture("fields", "verify-failure"); await expect(f.app.apply(f.plan.id, f.context)).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN", retryable: false });
    f.recoverVerification(); const result = await f.app.verifyConfirmed(f.plan.id, f.context);
    expect(result.execution.state).toBe("applied"); expect(f.emitted()).toBe(1);
  });
  it("does not send when native permission is rejected", async () => {
    const f = await fixture(); f.deny(); await expect(f.app.apply(f.plan.id, f.context)).rejects.toThrow("native denied"); expect(f.emitted()).toBe(0);
  });
  it("offers an operator read-only receipt check without granting another application", async () => {
    const f = await fixture("fields", "verify-failure"); await expect(f.app.apply(f.plan.id, f.context)).rejects.toBeInstanceOf(Error);
    f.recoverVerification(); f.account.readOnly = true;
    expect((await inspectProposal(f.plan.id, f.data)).state).toBe("unknown");
    expect((await verifyRecorded(f.plan.id, f.c, { data: f.data, fetcher: f.fetcher })).state).toBe("applied"); expect(f.emitted()).toBe(1);
  });
  it("never turns an uncertain send without receipt into a prepared retry", async () => {
    const f = await fixture("fields", "disconnect"); await f.app.apply(f.plan.id, f.context);
    const requests = f.fetcher.mock.calls.length;
    expect((await verifyRecorded(f.plan.id, f.c, { data: f.data, fetcher: f.fetcher })).state).toBe("unknown");
    expect(f.fetcher).toHaveBeenCalledTimes(requests); expect(f.emitted()).toBe(1);
  });
  it("blocks real fresh-ticket drift and readOnly policy changes", async () => {
    for (const cause of ["drift", "readonly"]) {
      const f = await fixture(); if (cause === "drift") f.drift(); else f.account.readOnly = true;
      await expect(f.app.apply(f.plan.id, f.context)).rejects.toBeInstanceOf(Error); expect(f.emitted()).toBe(0);
    }
  });
  it("rejects a changed site before reading or sending to another destination", async () => {
    const f = await fixture(); f.fetcher.mockClear(); f.account.siteUrl = "https://other.atlassian.net";
    await expect(f.app.apply(f.plan.id, f.context)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.emitted()).toBe(0);
  });
  it("stops after identity validation rather than reading a ticket under a substituted identity", async () => {
    const f = await fixture(); f.fetcher.mockClear();
    f.fetcher.mockImplementation(async (url) => { expect(new URL(String(url)).pathname).toBe("/rest/api/3/myself"); return json({ accountId: "substituted", active: true }); });
    await expect(f.app.apply(f.plan.id, f.context)).rejects.toMatchObject({ code: "CONFLICT" }); expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.emitted()).toBe(0);
  });
  it.each(["key", "project"])("does not reuse a malformed remote %s in API paths or permission resources", async (part) => {
    const f = await fixture(); f.fetcher.mockClear();
    f.fetcher.mockImplementation(async (url) => {
      if (new URL(String(url)).pathname.endsWith("/myself")) return json({ accountId: "person", active: true });
      const remote = issue(); if (part === "key") remote.key = "IK-1?fields=unexpected"; else remote.fields.project.key = "IK/other"; return json(remote);
    });
    await expect(f.app.apply(f.plan.id, f.context)).rejects.toMatchObject({ code: "INVALID_RESPONSE" }); expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.emitted()).toBe(0);
  });
});
