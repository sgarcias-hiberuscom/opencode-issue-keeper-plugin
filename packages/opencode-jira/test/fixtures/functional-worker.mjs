import { readFile } from "node:fs/promises";
import { ChangeStore } from "../../src/state/store.ts";
import { ChangeApplication } from "../../src/state/application.ts";
import { HttpClient } from "../../src/http.ts";
import { JiraChangeAdapter } from "../../src/jira/changes.ts";

const [data, proposalId, configuration, checkpoint, target] = process.argv.slice(2);
const config = JSON.parse(await readFile(configuration, "utf8"));
const store = new ChangeStore(data); const { plan } = store.get(proposalId); store.close();
const requests = new Map(); let sequence = 0; let currentStep;
process.on("message", (message) => {
  if (message.type !== "response") return;
  const pending = requests.get(message.id); requests.delete(message.id);
  if (message.error) pending.reject(new Error("Synthetic HTTP failure"));
  else pending.resolve(new Response(message.status === 204 ? null : message.body, { status: message.status, headers: message.headers }));
});
const pause = async () => { process.send({ type: "checkpoint", checkpoint, target }); await new Promise(() => {}); };
globalThis.fetch = () => { throw new Error("Worker network prohibited"); };
const http = new HttpClient(config, async (url, init) => {
  let body = init.body;
  if (body && typeof body !== "string") body = Buffer.from(await new Response(body).arrayBuffer());
  const id = ++sequence;
  const response = await new Promise((resolve, reject) => {
    requests.set(id, { resolve, reject });
    process.send({ type: "fetch", id, url: String(url), method: init.method, body, headers: Object.fromEntries([...new Headers(init.headers)].filter(([key]) => key !== "authorization")) });
  });
  if (checkpoint === "accepted" && currentStep === target && ["POST", "PUT"].includes(init.method)) await pause();
  return response;
});
const context = { sessionID: plan.sessionID, signal: new AbortController().signal, resolve: async () => ({ sessionID: plan.sessionID, locationID: plan.locationID }) };
const adapter = new JiraChangeAdapter(() => config, http, async () => {}, { data, authorizeDownload: async () => {} });
const ports = {
  validate: async (...args) => { if (checkpoint === "verified" && args[3]?.receipts[target]?.verifiedAt) await pause(); return adapter.validate(...args); },
  present: async (_review, _context, recorded) => recorded,
  authorize: async () => {},
  send: async (plan, step, binding, context, beforeSend, progress) => { currentStep = step.id; return adapter.send(plan, step, binding, context, async () => { await beforeSend(); if (checkpoint === "sending" && step.id === target) await pause(); }, progress); },
  verify: async (plan, step, ...rest) => { if (checkpoint === "confirmed" && step.id === target) await pause(); return adapter.verify(plan, step, ...rest); },
};
try {
  await new ChangeApplication(ports, { data }).apply(proposalId, context);
  if (checkpoint === "verified") await pause();
  process.send({ type: "unexpected-completion" });
} catch (error) { process.send({ type: "failure", code: error.reason ?? error.code ?? error.name }); }
finally { http.close(); }
