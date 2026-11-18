import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [installed, configPath, manifestPath, output, authorization] = process.argv.slice(2);
assert(authorization === "--qa-authorized", "Usage: phase2-fixtures.mjs PACKAGE CONFIG MANIFEST OUTPUT --qa-authorized");
process.umask(0o077);
const require = createRequire(join(resolve(installed), "package.json"));
const config = require("jsonc-parser").parse(await readFile(configPath, "utf8"));
const plugins = config.plugins.filter((item) => item?.package?.includes("opencode-jira")); assert.equal(plugins.length, 1);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert(manifest.version === 1 && Array.isArray(manifest.operations) && manifest.operations.length <= 20);
const { authorization: credentials } = await import(pathToFileURL(join(resolve(installed), "dist/credentials.js")).href);
await mkdir(output, { mode: 0o700 });
const evidence = { startedAt: new Date().toISOString(), ledger: [], results: {} };
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => !["emailAddress", "avatarUrls", "_links", "self", "iconUrl", "thumbnail", "content", "avatarId"].includes(key) && !(typeof item === "string" && /^https?:/.test(item)))
    .map(([key, item]) => [key, sanitize(item)]));
  return value;
}
const save = () => writeFile(join(output, "fixtures.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
try {
  for (const operation of manifest.operations) {
    assert(/^[a-zA-Z0-9_-]+$/.test(operation.id) && !Object.hasOwn(evidence.results, operation.id));
    const account = plugins[0].options.accounts.find((account) => account.id === operation.account);
    assert(account && new URL(account.siteUrl).origin === operation.site, "Explicit QA site required");
    const method = operation.body === undefined ? "GET" : "POST";
    const path = operation.path;
    assert(typeof path === "string" && !/[#\\\r\n]/.test(path));
    if (method === "GET") assert(/^rest\/(?:api\/3\/(?:myself|issue\/[A-Z][A-Z0-9_]*-\d+(?:\/editmeta|\/transitions)?|project\/[A-Z][A-Z0-9_]*\/roledetails|user\/groups)|servicedeskapi\/(?:servicedesk(?:\/\d+\/requesttype(?:\/\d+\/field)?)?|request\/[A-Z][A-Z0-9_]*-\d+))(?:\?[^#]*)?$/.test(path), "Unsupported inventory read");
    else {
      assert(["rest/api/3/issue", "rest/servicedeskapi/request"].includes(path), "Only fixture creation is supported");
      if (path === "rest/api/3/issue") {
        assert(operation.body.fields?.project?.key === operation.project && /^[A-Z][A-Z0-9_]*$/.test(operation.project));
        assert(operation.body.fields?.summary?.startsWith("IK-M5-QA "));
        assert(Object.keys(operation.body).every((key) => key === "fields"));
        assert(Object.keys(operation.body.fields).every((key) => ["project", "issuetype", "summary", "description", "labels"].includes(key)));
      } else {
        assert(/^\d+$/.test(operation.body.serviceDeskId) && /^\d+$/.test(operation.body.requestTypeId));
        assert(operation.body.requestFieldValues?.summary?.startsWith("IK-M5-QA "));
        assert(Object.keys(operation.body).every((key) => ["serviceDeskId", "requestTypeId", "requestFieldValues"].includes(key)));
        assert(Object.keys(operation.body.requestFieldValues).every((key) => ["summary", "description"].includes(key)));
      }
    }
    const prefix = account.auth.mode === "cloud-scoped-token" ? `https://api.atlassian.com/ex/jira/${account.auth.cloudId}/` : `${account.siteUrl}/`;
    const entry = { id: operation.id, account: operation.account, method, state: "sending", at: new Date().toISOString() };
    evidence.ledger.push(entry); await save();
    const response = await fetch(new URL(path, prefix), { method, redirect: "manual", signal: AbortSignal.timeout(30000), headers: { Authorization: await credentials(account), Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) }, ...(method === "POST" ? { body: JSON.stringify(operation.body) } : {}) });
    entry.status = response.status;
    entry.state = response.ok ? "confirmed" : "rejected"; await save();
    const text = await response.text(); assert(Buffer.byteLength(text) <= 2 * 1024 * 1024);
    const body = text ? JSON.parse(text) : null;
    evidence.results[operation.id] = { status: response.status, data: sanitize(body) }; await save();
    assert(response.ok, `Fixture operation ${operation.id}: HTTP ${response.status}`);
  }
  evidence.success = true;
} catch (error) {
  evidence.success = false;
  evidence.failure = error.name === "AssertionError" ? error.message : "Interrupted operation; inspect ledger before continuing, never repeat an uncertain POST";
  const entry = evidence.ledger.at(-1); if (entry?.state === "sending") entry.state = "unknown";
  process.exitCode = 1;
} finally { await save(); }
console.log(JSON.stringify({ output, success: evidence.success, requests: evidence.ledger.length, mutations: evidence.ledger.filter((entry) => entry.method === "POST").length }));
