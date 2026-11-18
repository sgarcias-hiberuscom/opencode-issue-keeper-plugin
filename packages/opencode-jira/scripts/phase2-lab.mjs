import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const mode = process.argv[2] ?? "inventory";
assert(["inventory", "audience", "format", "breaks"].includes(mode));
const writes = ["format", "breaks"].includes(mode);
assert(!writes || process.argv.includes("--qa-authorized"), "Las escrituras QA requieren autorización explícita.");
process.umask(0o077);
const config = JSON.parse(await readFile("/root/.config/opencode/opencode.jsonc", "utf8"));
const plugin = config.plugins.find((item) => typeof item === "object" && item.package?.includes("opencode-jira"));
assert(plugin);
const { authorization } = await import(pathToFileURL(join(plugin.package, "dist/credentials.js")).href);
const root = `/root/ik-phase2-lab/${new Date().toISOString().replaceAll(":", "-")}-${mode}-${randomUUID().slice(0, 8)}`;
await mkdir(root, { recursive: true, mode: 0o700 });
const ledger = [];
const evidence = { mode, createdAt: new Date().toISOString(), node: process.version, activeCopy: plugin.package, retentionReview: "2026-11-24", profiles: [], results: {} };
evidence.activeFiles = Object.fromEntries(await Promise.all(["dist/index.js", "README.md", "package.json", "options.schema.json"].map(async (path) => [path, createHash("sha256").update(await readFile(join(plugin.package, path))).digest("hex")])));
evidence.permissions = config.permissions?.filter((item) => item.action.startsWith("jira."));
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => !["emailAddress", "avatarUrls", "_links", "self", "iconUrl", "thumbnail"].includes(key) && !(key === "content" && typeof item === "string" && item.startsWith("https://")))
    .map(([key, item]) => [key, sanitize(item)]));
  return value;
}
async function save() {
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  await writeFile(join(root, "ledger.json"), JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
}
async function request(alias, path, body, multipart = false) {
  const account = plugin.options.accounts.find((item) => item.id === alias);
  assert(account && ["https://issuekeeper-qa-agent.atlassian.net", "https://issuekeeper-qa-client.atlassian.net"].includes(account.siteUrl));
  assert(/^rest\/(?:api\/3\/|servicedeskapi\/)/.test(path) && !/[#\\\r\n]/.test(path));
  if (body !== undefined) assert(writes && (path === "rest/api/3/issue/QA-1/comment" || /^rest\/servicedeskapi\/(?:request\/SD-5\/(?:comment|attachment)|servicedesk\/\d+\/attachTemporaryFile)$/.test(path)));
  const base = account.auth.mode === "cloud-scoped-token" ? `https://api.atlassian.com/ex/jira/${account.auth.cloudId}/` : `${account.siteUrl}/`;
  const entry = { alias, path, method: body === undefined ? "GET" : "POST", state: "sending", at: new Date().toISOString() };
  ledger.push(entry); await save();
  try {
    const response = await fetch(new URL(path, base), {
      method: entry.method, redirect: "manual", signal: AbortSignal.timeout(20000),
      headers: { Authorization: await authorization(account), Accept: "application/json", ...(body === undefined ? {} : multipart ? { "X-Atlassian-Token": "no-check" } : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
    });
    entry.status = response.status;
    const text = await response.text(); assert(Buffer.byteLength(text) <= 2 * 1024 * 1024);
    const data = text ? JSON.parse(text) : null;
    entry.state = response.ok ? "confirmed" : "rejected";
    await save();
    return { status: response.status, data: sanitize(data) };
  } catch (error) { entry.state = "unknown"; await save(); throw new Error(`Resultado incierto en ${alias}/${entry.method}; no reenviar. ${error.name}`); }
}
async function record(key, alias, path) { const result = await request(alias, path); evidence.results[key] = result; await save(); return result; }
try {
  for (const account of plugin.options.accounts) {
    const credential = account.auth.tokenFile ? await stat(account.auth.tokenFile) : undefined;
    evidence.profiles.push({ id: account.id, readOnly: account.readOnly, mode: account.auth.mode, credentialMode: credential ? credential.mode & 0o777 : "env", identity: (await record(`identity-${account.id}`, account.id, "rest/api/3/myself")).data?.accountId });
  }
  const qa = await record("platform", "qa", "rest/api/3/issue/QA-1?fields=summary,project,updated,status,reporter");
  const sd = await record("request", "soporte", "rest/servicedeskapi/request/SD-5");
  await record("customer-request", "cliente", "rest/servicedeskapi/request/SD-5");
  await record("other-site", "otro", "rest/api/3/issue/SCRUM-5?fields=project,updated,status");
  await record("editmeta", "qa", "rest/api/3/issue/QA-1/editmeta");
  await record("transitions", "qa", "rest/api/3/issue/QA-1/transitions?expand=transitions.fields");
  await record("permissions", "soporte", "rest/api/3/mypermissions?issueKey=SD-5&permissions=BROWSE_PROJECTS,ADD_COMMENTS,ASSIGN_ISSUES,TRANSITION_ISSUES,EDIT_ISSUES");
  await record("roles", "soporte", "rest/api/3/project/SD/roledetails");
  await record("participants", "soporte", "rest/servicedeskapi/request/SD-5/participant?limit=100");
  await record("assignable", "qa", "rest/api/3/user/assignable/search?issueKey=QA-1&maxResults=100");
  assert.equal(qa.status, 200); assert.equal(sd.status, 200);
  if (mode === "audience") {
    await record("support-role", "soporte", "rest/api/3/project/SD/role/10011");
    const roles = await record("platform-roles", "qa", "rest/api/3/project/QA/roledetails");
    for (const role of roles.data.filter((item) => !item.name.includes("addons"))) await record(`platform-role-${role.id}`, "qa", `rest/api/3/project/QA/role/${role.id}`);
    for (const profile of evidence.profiles.filter((item) => ["soporte", "cliente"].includes(item.id))) {
      await record(`user-${profile.id}`, "soporte", `rest/api/3/user?accountId=${encodeURIComponent(profile.identity)}&expand=applicationRoles,groups`);
      await record(`groups-${profile.id}`, "soporte", `rest/api/3/user/groups?accountId=${encodeURIComponent(profile.identity)}`);
      await record(`issue-access-${profile.id}`, "soporte", `rest/api/3/user/viewissue/search?issueKey=SD-5&accountId=${encodeURIComponent(profile.identity)}&maxResults=100`);
    }
  }
  if (mode === "breaks") {
    const body = `IK-PHASE2-BREAKS-${randomUUID()}\n\nLF-A\nLF-B\n\nCRLF-A\r\nCRLF-B\n\nESC-A${String.raw`\\`}ESC-B\n\nESCNL-A${String.raw`\\`}\nESCNL-B`;
    const created = await request("soporte", "rest/servicedeskapi/request/SD-5/comment", { body, public: false });
    evidence.results.created = created; await save(); assert.equal(created.status, 201);
    await record("breaks-adf", "soporte", `rest/api/3/issue/SD-5/comment/${created.data.id}?expand=renderedBody`);
  }
  if (mode === "format") {
    const agent = evidence.profiles.find((item) => item.id === "soporte").identity;
    const customer = evidence.profiles.find((item) => item.id === "cliente").identity;
    const marker = `IK-PHASE2-VIA-${randomUUID()}`;
    const wiki = (id) => `${marker}\n\nh3. Encabezado\n\nPárrafo con *negrita*, _cursiva_ y [enlace|https://example.com].\n\nLínea uno${String.raw`\\`}\r\nLínea dos 😀\n\n* uno\n** dos\n\n# primero\n# segundo\n\n{code:javascript}\nconst x = "[~accountid:${id}]";\n{code}\n\n{{literal}}\n\n{quote}cita{quote}\n\n||Columna A||Columna B||\n|celda|valor|\n\nMención [~accountid:${id}] repetida [~accountid:${id}]\n\nLiteral ${String.raw`\[~accountid:${id}\]`} y ${String.raw`\*símbolos\*`}\n\nFIN-${marker}`;
    const text = (value) => ({ type: "text", text: value });
    const paragraph = (value) => ({ type: "paragraph", content: [text(value)] });
    const adf = { version: 1, type: "doc", content: [
      paragraph(marker), { type: "heading", attrs: { level: 3 }, content: [text("Encabezado")] },
      { type: "paragraph", content: [text("Párrafo"), { type: "hardBreak" }, { ...text("negrita"), marks: [{ type: "strong" }] }, { ...text("cursiva"), marks: [{ type: "em" }] }, { ...text("enlace"), marks: [{ type: "link", attrs: { href: "https://example.com" } }] }] },
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph("uno"), { type: "bulletList", content: [{ type: "listItem", content: [paragraph("dos")] }] }] }] },
      { type: "orderedList", attrs: { order: 1 }, content: [{ type: "listItem", content: [paragraph("primero")] }, { type: "listItem", content: [paragraph("segundo")] }] },
      { type: "codeBlock", attrs: { language: "javascript" }, content: [text("const x = 1;")] },
      { type: "paragraph", content: [{ ...text("literal"), marks: [{ type: "code" }] }] },
      { type: "blockquote", content: [paragraph("cita")] },
      { type: "table", attrs: { isNumberColumnEnabled: false, layout: "default" }, content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [paragraph("Columna A")] }, { type: "tableHeader", content: [paragraph("Columna B")] }] }, { type: "tableRow", content: [{ type: "tableCell", content: [paragraph("celda")] }, { type: "tableCell", content: [paragraph("valor")] }] }] },
      { type: "paragraph", content: [text("Mención "), { type: "mention", attrs: { id: agent, text: "Agente QA" } }] },
      { type: "paragraph", content: [text("Repetida "), { type: "mention", attrs: { id: agent, text: "Agente QA" } }] }, paragraph(`Literal [~accountid:${agent}] **símbolos** 😀`), paragraph(`FIN-${marker}`),
    ] };
    const platform = await request("qa", "rest/api/3/issue/QA-1/comment", { body: adf });
    evidence.results["platform-created"] = platform; await save(); assert.equal(platform.status, 201);
    await record("platform-readback", "qa", `rest/api/3/issue/QA-1/comment/${platform.data.id}?expand=renderedBody`);
    for (const publicValue of [false, true]) {
      const audience = publicValue ? "public" : "internal";
      const body = wiki(publicValue ? customer : agent);
      const created = await request("soporte", "rest/servicedeskapi/request/SD-5/comment", { body, public: publicValue });
      evidence.results[`${audience}-created`] = created; await save(); assert.equal(created.status, 201);
      await record(`${audience}-readback`, "soporte", `rest/servicedeskapi/request/SD-5/comment/${created.data.id}?expand=renderedBody`);
      await record(`${audience}-platform-readback`, "soporte", `rest/api/3/issue/SD-5/comment/${created.data.id}?expand=renderedBody`);
      await record(`${audience}-customer`, "cliente", `rest/servicedeskapi/request/SD-5/comment/${created.data.id}?expand=renderedBody`);
      const form = new FormData(); form.append("file", new Blob([`${marker} ${audience}\n`], { type: "text/plain" }), `via-${audience}.txt`);
      const temporary = await request("soporte", `rest/servicedeskapi/servicedesk/${sd.data.serviceDeskId}/attachTemporaryFile`, form, true);
      evidence.results[`${audience}-temporary`] = temporary; await save(); assert.equal(temporary.status, 201);
      const ids = temporary.data.temporaryAttachments.map((item) => item.temporaryAttachmentId); assert.equal(ids.length, 1);
      const published = await request("soporte", "rest/servicedeskapi/request/SD-5/attachment", { public: publicValue, temporaryAttachmentIds: ids, additionalComment: { body } });
      evidence.results[`${audience}-attachments-created`] = published; await save(); assert.equal(published.status, 201);
      const id = published.data.comment.id;
      await record(`${audience}-additional-readback`, "soporte", `rest/servicedeskapi/request/SD-5/comment/${id}?expand=renderedBody`);
      await record(`${audience}-additional-platform`, "soporte", `rest/api/3/issue/SD-5/comment/${id}?expand=renderedBody`);
      await record(`${audience}-additional-customer`, "cliente", `rest/servicedeskapi/request/SD-5/comment/${id}?expand=renderedBody`);
    }
  }
  evidence.success = true;
} catch (error) { evidence.success = false; evidence.failure = error.name === "AssertionError" ? error.message : "La operación no terminó; revisar evidencia privada sin reenviar."; process.exitCode = 1; }
finally { await save(); }
console.log(JSON.stringify({ mode, success: evidence.success, evidence: join(root, "evidence.json"), requests: ledger.length, mutations: ledger.filter((item) => item.method !== "GET").length, uncertain: ledger.filter((item) => item.state === "unknown").length }));
