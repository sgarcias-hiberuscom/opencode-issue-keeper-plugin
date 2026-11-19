import Database from "better-sqlite3";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { config, issue, json, mockFetch, request } from "./helpers.js";
import { HttpClient } from "../src/http.js";
import { Service } from "../src/core/service.js";
import { JiraCloud } from "../src/jira/cloud.js";
import { toolHarness } from "./harness.js";
import { ChangeStore } from "../src/state/store.js";
import { statePaths } from "../src/state/paths.js";
import { changeReview } from "../src/core/review.js";
import type { ChangePlan, JsonValue } from "../src/core/proposals.js";

export async function changeFixture(scoped = false, dataOverride?: string) {
  const root = await mkdtemp("/tmp/opencode/jira-changes-"); const location = join(root, "location"); const data = dataOverride ?? join(root, "data");
  await mkdir(join(location, "exports"), { recursive: true, mode: 0o700 });
  const c = config(true); c.accounts[0]!.readOnly = false; c.http.readMaxAttempts = 1; c.http.maxConcurrentPerAccount = 1;
  if (scoped) c.accounts[0]!.auth = { ...c.accounts[0]!.auth, mode: "cloud-scoped-token", cloudId: "11111111-2222-4333-8444-555555555555" };
  const remote = { ...issue(), fields: { ...issue().fields, attachment: [] as Array<{ id: string }> } };
  const comments = new Map<string, Record<string, unknown>>(); const files = new Map<string, { bytes: Buffer; filename: string }>(); const temporaries = new Map<string, { bytes: Buffer; filename: string }>();
  const ledger: Array<{ path: string; body: unknown; bytes?: Buffer }> = [];
  const faults = { rejectAt: 0, disconnectAt: 0, malformedAt: 0, blockAfter: 0, verifyFailure: false, wrongHash: false, wrongAudience: false, mentionsMissing: false, incompleteHistory: false, foreignHistory: false, driftAfterVerify: false, inactive: false, denyAudience: false, sortLabels: false, resolvedMentionLabels: false, emptyDocumentOnClear: false, resolvedVisibility: false, transitionAvailable: true, visibilityGroupId: "1", uploadLimit: 10000000, identity: "person" };
  let verifiedReads = 0;
  const histories: Array<{ created: string; author: { accountId: string }; items: Array<{ field: string; to: string }> }> = [];
  const addFile = (file: { bytes: Buffer; filename: string }) => { const id = String(100 + files.size); files.set(id, file); remote.fields.attachment.push({ id }); return id; };
  const fetcher = mockFetch(async (url, init) => {
    const path = url.pathname.replace(/^\/ex\/jira\/[^/]+/, "");
    if (path === "/_edge/tenant_info") return json({ cloudId: c.accounts[0]!.auth.mode === "cloud-scoped-token" ? c.accounts[0]!.auth.cloudId : "none" });
    if (scoped) { expect(url.origin).toBe("https://api.atlassian.com"); expect(url.pathname).toContain("/ex/jira/"); }
    if (init.method === "POST" || init.method === "PUT") {
      const db = new Database(statePaths(data).database, { readonly: true });
      try { const rows = db.prepare("SELECT document FROM executions WHERE state='applying'").all() as Array<{ document: string }>; expect(rows.some((row) => JSON.parse(row.document).steps.some((step: { state: string }) => step.state === "sending"))).toBe(true); } finally { db.close(); }
      let body: unknown = init.body;
      let file: { bytes: Buffer; filename: string } | undefined;
      if (typeof body !== "string") {
        const bytes = Buffer.from(await new Response(body as BodyInit).arrayBuffer()); const split = bytes.indexOf("\r\n\r\n"); const last = bytes.lastIndexOf("\r\n--");
        file = { bytes: bytes.subarray(split + 4, last), filename: /filename="([^"]+)"/.exec(bytes.subarray(0, split).toString())![1]! };
        expect(new Headers(init.headers).get("X-Atlassian-Token")).toBe("no-check"); body = { filename: file.filename };
      } else body = JSON.parse(body);
      ledger.push({ path, body, ...(file ? { bytes: file.bytes } : {}) }); const attempt = ledger.length;
      if (faults.rejectAt === attempt) return json({}, 429);
      const payload = body as Record<string, any>; let response: Response;
      if (path.endsWith("/attachTemporaryFile")) {
        const id = `temporary-${temporaries.size + 1}`; temporaries.set(id, file!); response = json({ temporaryAttachments: [{ temporaryAttachmentId: id, fileName: file!.filename }] }, 201);
      } else if (path.endsWith("/attachments")) {
        const id = addFile(file!); remote.fields.updated = new Date(Date.parse(remote.fields.updated) + 1000).toISOString(); histories.push({ created: remote.fields.updated, author: { accountId: "person" }, items: [{ field: "Attachment", to: id }] }); response = json([{ id }]);
      } else if (path.endsWith("/attachment")) {
        const ids = (payload.temporaryAttachmentIds as string[]).map((id) => addFile(temporaries.get(id)!)); const id = String(500 + comments.size);
        const comment = { id, author: { accountId: "person" }, body: (payload.additionalComment?.body ?? "") + "\n\n" + ids.map((id) => `[^${files.get(id)!.filename}] _(0.1 kB)_`).join("\n"), public: payload.public }; comments.set(id, comment);
        remote.fields.updated = new Date(Date.parse(remote.fields.updated) + 1000).toISOString(); response = json({ comment, attachments: { values: ids.map((id) => ({ filename: files.get(id)!.filename, size: files.get(id)!.bytes.length, _links: { jiraRest: `${c.accounts[0]!.siteUrl}/rest/api/3/attachment/${id}` } })) } }, 201);
      } else if (path.endsWith("/comment")) {
        const visibility = payload.visibility?.identifier ? { ...payload.visibility, value: payload.visibility.type === "group" ? "team" : payload.visibility.identifier } : payload.visibility;
        const id = String(500 + comments.size); const comment = { id, ...payload, ...(visibility ? { visibility } : {}), author: { accountId: "person" } }; comments.set(id, comment); remote.fields.updated = new Date(Date.parse(remote.fields.updated) + 1000).toISOString(); response = json(comment, 201);
      } else {
        const fields = remote.fields as Record<string, unknown>;
        Object.assign(fields, payload.fields ?? {});
        for (const [field, operations] of Object.entries(payload.update ?? {}) as Array<[string, Array<Record<string, unknown>>]>) for (const operation of operations) {
          if ("set" in operation) fields[field] = operation.set;
          else if ("add" in operation) { if (!(fields[field] as unknown[]).includes(operation.add)) fields[field] = [...fields[field] as unknown[], operation.add]; }
          else fields[field] = (fields[field] as unknown[]).filter((value) => value !== operation.remove);
        }
        if (payload.transition) remote.fields.status.id = payload.transition.id === "31" ? "4" : "5";
        if (faults.sortLabels) remote.fields.labels.sort();
        if (faults.emptyDocumentOnClear && fields.description === null) fields.description = { type: "doc", version: 1, content: [] };
        remote.fields.updated = new Date(Date.parse(remote.fields.updated) + 1000).toISOString(); response = new Response(null, { status: 204 });
      }
      if (faults.disconnectAt === attempt) throw new Error("accepted; response lost");
      if (faults.malformedAt === attempt) return json({ malformed: true }, response.status);
      return response;
    }
    if (path.endsWith("/myself")) { if (faults.blockAfter && ledger.length >= faults.blockAfter) throw new Error("Synthetic revalidation outage"); return json({ accountId: faults.identity, active: true }); }
    if (path.endsWith("/mypermissions")) return json({ permissions: Object.fromEntries(["EDIT_ISSUES", "TRANSITION_ISSUES", "ADD_COMMENTS", "CREATE_ATTACHMENTS"].map((permission) => [permission, { havePermission: true }])) });
    if (path.endsWith("/attachment/meta")) return json({ enabled: true, uploadLimit: faults.uploadLimit });
    if (path.endsWith("/editmeta")) return json({ fields: {
      summary: { name: "Resumen", required: true, schema: { type: "string" }, operations: ["set"] },
      labels: { name: "Etiquetas", required: false, schema: { type: "array", items: "string" }, operations: ["set", "add", "remove"] },
      description: { name: "Descripción", required: false, schema: { type: "string" }, operations: ["set"] },
      assignee: { name: "Asignado", required: false, schema: { type: "user" }, operations: ["set"] },
    } });
    if (path.endsWith("/transitions")) return json({ transitions: faults.transitionAvailable ? [{ id: "31", name: "Hecho", to: { id: "4", name: "Hecho" }, fields: { summary: { name: "Resumen", required: true, schema: { type: "string" }, operations: ["set"] } } }] : [] });
    if (path.endsWith("/user/assignable/search") || path.endsWith("/user/viewissue/search")) return json(faults.denyAudience ? [] : [{ accountId: url.searchParams.get("accountId"), active: !faults.inactive }]);
    if (path.endsWith("/user")) return json({ accountId: url.searchParams.get("accountId"), active: !faults.inactive, displayName: "Nombre validado", applicationRoles: { size: 1, items: [{ key: "jira-servicedesk" }] } });
    if (path.endsWith("/roledetails")) return json([{ name: "Service Desk Team", id: 1 }, { name: "Team", id: 2 }]);
    if (/\/role\/[12]$/.test(path)) return json({ actors: faults.denyAudience ? [] : [{ actorUser: { accountId: "person" } }] });
    if (path.endsWith("/user/groups")) return json(faults.denyAudience ? [] : [{ name: "team", groupId: faults.visibilityGroupId }]);
    if (path.endsWith("/participant")) return json({ values: [{ accountId: "customer" }], isLastPage: true });
    if (/\/comment\/\d+$/.test(path)) {
      if (faults.verifyFailure) throw new Error("verification down");
      const comment = comments.get(path.split("/").at(-1)!)!;
      if (path.startsWith("/rest/api/3/") && typeof comment.body === "string") {
        const source = comment.body.replace(/\{code\}[\s\S]*?\{code\}|\{\{[^}]*\}\}/g, "");
        const mentions = faults.mentionsMissing ? [] : [...source.matchAll(/(?<!\\)\[~accountid:([^\]]+)\]/g)].map((match) => ({ type: "mention", attrs: { id: match[1], text: "Nombre validado" } }));
        return json({ ...comment, body: { type: "doc", version: 1, content: [{ type: "paragraph", content: mentions }] } });
      }
      if (faults.resolvedMentionLabels && typeof comment.body === "object") {
        const resolved = JSON.parse(JSON.stringify(comment, (key, value) => key === "attrs" && value?.id && value?.text ? { ...value, text: `@${value.text}`, accessLevel: "" } : value));
        return json(resolved);
      }
      if (faults.resolvedVisibility && comment.visibility) { const visibility = comment.visibility as { value: string; identifier?: string }; return json({ ...comment, visibility: { ...visibility, identifier: visibility.identifier ?? visibility.value } }); }
      return json(faults.wrongAudience ? { ...comment, public: !comment.public } : comment);
    }
    if (/\/attachment\/content\/\d+$/.test(path)) { const bytes = files.get(path.split("/").at(-1)!)!.bytes; return new Response(faults.wrongHash ? new Uint8Array(bytes.map((v) => v ^ 1)) : new Uint8Array(bytes)); }
    if (/\/attachment\/\d+$/.test(path)) { const id = path.split("/").at(-1)!; const file = files.get(id)!; return json({ id: Number(id), filename: file.filename, size: file.bytes.length, author: { accountId: "person" } }); }
    if (path.startsWith("/rest/servicedeskapi/request/")) return json(request());
    if (path.startsWith("/rest/api/3/issue/")) {
      if (faults.verifyFailure && ledger.length) throw new Error("verification down");
      if (faults.driftAfterVerify && files.size && ++verifiedReads > 2) remote.fields.updated = new Date(Date.parse(remote.fields.updated) + 1000).toISOString();
      const requested = url.searchParams.get("fields")?.split(",");
      const observed = faults.foreignHistory ? [...histories, { created: remote.fields.updated, author: { accountId: "other" }, items: [{ field: "summary", to: "other" }] }] : histories;
      return json({ ...remote, ...(url.searchParams.get("expand") === "changelog" ? { changelog: { total: observed.length + (faults.incompleteHistory ? 1 : 0), histories: observed } } : {}), fields: Object.fromEntries(Object.entries(remote.fields).filter(([field]) => !requested || requested.includes(field))) });
    }
    throw new Error(`Unexpected synthetic endpoint: ${path}`);
  });
  const http = new HttpClient(c, fetcher); const service = await Service.create(c, location, new JiraCloud(c, http)); const harness = await toolHarness(service, { http, data });
  async function prepare(tool: string, extra: Record<string, unknown> = {}, acknowledge = true) {
    const result = await harness.invoke(tool, { account: "work", issueKey: remote.key, expectedUpdated: remote.fields.updated, ...extra });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const store = new ChangeStore(data); let saved;
    try { saved = store.get(result.data.proposalId); if (acknowledge) store.acknowledgeReview(saved.plan.id, saved.execution.revision, changeReview(saved.plan).reviewHash); } finally { store.close(); }
    return saved.plan;
  }
  async function source(name = "archivo.txt", bytes = Buffer.from("contenido 😀\n")) { const path = join(location, "exports", name); await writeFile(path, bytes, { mode: 0o600 }); return { path: `exports/${name}` }; }
  async function saved(plan: ChangePlan) { const store = new ChangeStore(data); try { return store.get(plan.id); } finally { store.close(); } }
  return { root, data, location, c, http, service, harness, remote, files, comments, temporaries, ledger, faults, fetcher, prepare, source, saved, close: async () => { await harness.close(); service.close(); } };
}
