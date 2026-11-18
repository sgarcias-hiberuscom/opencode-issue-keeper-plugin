import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const [installed, phase, record] = process.argv.slice(2);
const load = (name) => import(pathToFileURL(join(installed, "dist", `${name}.js`)).href);
const { ChangeStore } = await load("state/store");
const { userDataDirectory, statePaths } = await load("state/paths");
const data = userDataDirectory();
const Database = createRequire(join(installed, "package.json"))("better-sqlite3");
if (phase === "inspect") {
  const { proposalId, payloadHash } = JSON.parse(await readFile(record, "utf8"));
  const store = new ChangeStore(data);
  try { const saved = store.get(proposalId); assert.equal(saved.execution.state, "applied"); assert.equal(saved.payloadHash, payloadHash); assert(saved.receipts[saved.plan.steps[0].id].verifiedAt); }
  finally { store.close(); }
  process.exit(0);
}
const location = process.cwd();
const tools = new Map(); const permissions = []; let mutations = 0;
process.env.ISSUEKEEPER_PACK_TOKEN = "synthetic-package-test-only";
const fields = { project: { id: "10", key: "SYN", projectTypeKey: "software" }, updated: "2026-11-17T10:00:00.000Z", summary: "Before", status: { id: "3", name: "Open" }, labels: [], assignee: null };
const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  assert.equal(url.origin, "https://synthetic.atlassian.net");
  if (init.method === "PUT") {
    assert.equal(url.pathname, "/rest/api/3/issue/SYN-2");
    const db = new Database(statePaths(data).database, { readonly: true });
    try { assert(db.prepare("SELECT document FROM executions WHERE state='applying'").all().some((row) => JSON.parse(row.document).steps.some((step) => step.state === "sending"))); }
    finally { db.close(); }
    mutations++; Object.assign(fields, JSON.parse(init.body).fields); fields.updated = "2026-11-17T10:00:01.000Z";
    return new Response(null, { status: 204 });
  }
  assert(!init.method || init.method === "GET", "No unexpected mutations or retries");
  if (url.pathname.endsWith("/myself")) return json({ accountId: "synthetic-person", active: true });
  if (url.pathname.endsWith("/mypermissions")) return json({ permissions: { EDIT_ISSUES: { havePermission: true } } });
  if (url.pathname.endsWith("/editmeta")) return json({ fields: { summary: { name: "Summary", required: true, schema: { type: "string" }, operations: ["set"] } } });
  assert.equal(url.pathname, "/rest/api/3/issue/SYN-2");
  return json({ id: "10002", key: "SYN-2", fields });
};
const { default: plugin } = await load("index");
const cleanup = await plugin.setup({
  options: { accounts: [{ id: "qa", siteUrl: "https://synthetic.atlassian.net", auth: { mode: "cloud-token", email: "synthetic@example.invalid", tokenEnv: "ISSUEKEEPER_PACK_TOKEN" }, readOnly: false }] },
  location: { directory: location }, session: { get: async () => ({ id: "pack-session", location: { directory: location } }) },
  permission: { assert: async (request) => { permissions.push(request); } },
  tool: { transform: async (callback) => callback({ namespace() {}, add(tool) { tools.set(tool.name, tool); } }) },
});
const invoke = async (name, input) => JSON.parse((await tools.get(name).execute(input, { sessionID: "pack-session", agent: "build", messageID: "pack-message", id: "pack-tool", signal: new AbortController().signal, progress: async () => {} })).content);
try {
  assert.equal(tools.size, 15);
  if (phase === "prepare") {
    const prepared = await invoke("issue_update_prepare", { account: "qa", issueKey: "SYN-2", expectedUpdated: fields.updated, fields: { summary: "After 😀" } });
    assert.equal(prepared.ok, true, JSON.stringify(prepared)); assert.equal(mutations, 0);
    const store = new ChangeStore(data);
    try {
      const saved = store.get(prepared.data.proposalId);
      const { changeReview } = await load("core/review");
      store.acknowledgeReview(saved.plan.id, saved.execution.revision, changeReview(saved.plan).reviewHash);
      await writeFile(record, JSON.stringify({ proposalId: saved.plan.id, payloadHash: saved.payloadHash }), { mode: 0o600, flag: "wx" });
    } finally { store.close(); }
  } else {
    assert.equal(phase, "apply"); const { proposalId, payloadHash } = JSON.parse(await readFile(record, "utf8"));
    const applied = await invoke("change_apply", { proposalId });
    assert.equal(applied.ok, true, JSON.stringify(applied)); assert.equal(applied.data.state, "applied", JSON.stringify(applied));
    assert.equal(mutations, 1); assert.equal(fields.summary, "After 😀");
    const write = permissions.filter((permission) => permission.action === "jira.write");
    assert.equal(write.length, 1); assert.deepEqual(write[0].save, write[0].resources); assert(write[0].resources[0].endsWith(payloadHash));
    assert.equal((await invoke("change_apply", { proposalId })).data.state, "applied"); assert.equal(mutations, 1);
  }
} finally { await cleanup?.(); }
