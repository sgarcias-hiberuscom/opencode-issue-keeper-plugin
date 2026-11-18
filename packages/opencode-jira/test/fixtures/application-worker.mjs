import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ChangeApplication } from "../../src/state/application.ts";
import { ChangeStore } from "../../src/state/store.ts";
import { HttpClient } from "../../src/http.ts";
import { JiraChangeAdapter } from "../../src/jira/changes.ts";
import { parseConfig } from "../../src/config.ts";
import { changePolicyFingerprint } from "../../src/core/change-policy.ts";
import { instant, planFixture } from "../state-fixtures.ts";

const [data, checkpoint] = process.argv.slice(2);
process.env.IK_SYNTHETIC_TOKEN = "synthetic-offline-only";
const config = parseConfig({ accounts: [{ id: "qa", siteUrl: "https://synthetic.atlassian.net", auth: { mode: "cloud-token", email: "qa@example.invalid", tokenEnv: "IK_SYNTHETIC_TOKEN" }, readOnly: false }] });
const plan = planFixture({ site: config.accounts[0].siteUrl, credentialIdentity: "person", policyFingerprint: changePolicyFingerprint(config, config.accounts[0]), payload: { request: { kind: "fields", issueKey: "SYN-1", fields: { summary: "Crash check" } }, expectedFields: { summary: "Crash check" } } });
const options = { data, now: () => new Date(instant) };
const context = { sessionID: plan.sessionID, signal: new AbortController().signal, resolve: async () => ({ sessionID: plan.sessionID, locationID: plan.locationID }) };
let summary = "Before";
const pause = async () => { process.send({ checkpoint, node: process.version }); await new Promise((resolve) => process.once("message", resolve)); };
globalThis.fetch = () => { throw new Error("Synthetic worker has no network"); };
const http = new HttpClient(config, async (url, init) => {
  const path = new URL(String(url)).pathname;
  const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  if (init.method === "PUT") {
    const fd = openSync(join(data, "synthetic-remote-ledger"), "a", 0o600);
    try { writeSync(fd, "accepted-step-1\n"); fsyncSync(fd); } finally { closeSync(fd); }
    summary = "Crash check";
    if (checkpoint === "accepted") await pause();
    return new Response(null, { status: 204 });
  }
  if (path.endsWith("/myself")) return json({ accountId: "person", active: true });
  if (path.endsWith("/mypermissions")) return json({ permissions: { EDIT_ISSUES: { havePermission: true } } });
  if (path.endsWith("/editmeta")) return json({ fields: { summary: { name: "Summary", required: true, schema: { type: "string" }, operations: ["set"] } } });
  if (path.endsWith("/SYN-1")) return json({ id: plan.issueId, key: plan.issueKey, fields: { project: { key: plan.projectKey }, updated: plan.expectedUpdated, status: { id: "1" }, summary } });
  throw new Error("Unexpected synthetic route");
});
const adapter = new JiraChangeAdapter(() => config, http, async () => {});
const ports = {
  validate: adapter.validate.bind(adapter),
  present: async (review) => ({ payloadHash: review.payloadHash, reviewHash: review.reviewHash, complete: true }),
  authorize: async () => { if (checkpoint === "review") await pause(); },
  send: (plan, step, binding, context, beforeSend) => adapter.send(plan, step, binding, context, async () => { await beforeSend(); if (checkpoint === "sending") await pause(); }),
  verify: async (...args) => { if (checkpoint === "confirmed") await pause(); return adapter.verify(...args); },
};
try {
  const application = new ChangeApplication(ports, options);
  await application.prepare(plan, context);
  await application.apply(plan.id, context);
  if (checkpoint === "verified") await pause();
} catch (error) { process.send({ error: error.reason ?? error.code ?? error.name }, () => process.exit(1)); }
finally { http.close(); }
