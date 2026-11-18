import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { changeReview, reviewHTML } from "../dist/core/review.js";

process.umask(0o077);
const root = await mkdtemp("/tmp/opencode/ik-review-client-");
const project = join(root, "project"); await mkdir(project, { mode: 0o700 });
const probe = join(root, "plugin"); await mkdir(probe, { mode: 0o700 });
const storeURL = new URL("../dist/state/store.js", import.meta.url).href;
const reviewURL = new URL("../dist/core/review.js", import.meta.url).href;
await writeFile(join(probe, "package.json"), JSON.stringify({ name: "ik-review-client-probe", type: "module", exports: { ".": "./index.mjs" }, dependencies: { "@opencode/plugin": "2.2.5" } }));
await writeFile(join(probe, "index.mjs"), `import{Plugin}from'@opencode/plugin';import{ChangeStore}from${JSON.stringify(storeURL)};import{changeReview}from${JSON.stringify(reviewURL)};import{readFile,writeFile}from'node:fs/promises';export default Plugin.define({id:'ik.review.spike',async setup(ctx){const store=new ChangeStore(${JSON.stringify(join(root, "sqlite-probe"))});try{await writeFile(${JSON.stringify(join(root, "native-store.json"))},JSON.stringify({node:process.version,usage:store.usage()}))}finally{store.close()}await ctx.command.transform(editor=>editor.add({name:'ik-review-spike',execute:async({sessionID})=>{const plan=JSON.parse(await readFile(${JSON.stringify(join(root, "plan.json"))},'utf8'));const review=changeReview(plan);await ctx.permission.assert({sessionID,action:'jira.write',resources:[review.resource],save:[review.resource],metadata:{proposalId:review.proposalId,payloadHash:review.payloadHash,reviewHash:review.reviewHash}})}}))}});`);
await mkdir(join(root, "config", "opencode"), { recursive: true, mode: 0o700 });
await writeFile(join(root, "config", "opencode", "opencode.json"), JSON.stringify({ plugins: [probe], update: "disable" }));
const password = randomUUID();
const inherited = Object.fromEntries(["PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
const env = { ...inherited, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), OPENCODE_PASSWORD: password };
const server = spawn(process.env.OPENCODE_BIN ?? "opencode", ["serve", "--hostname", "127.0.0.1", "--port", "42083"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = ""; let chrome; let socket;
const base = "http://127.0.0.1:42083";
const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "Content-Type": "application/json", "x-opencode-directory": encodeURIComponent(project) };
async function api(path, body) {
  const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  const text = await response.text(); const data = text ? JSON.parse(text) : undefined; assert(response.ok, `API ${path}: ${response.status}`); return data;
}
async function ready(process, pattern) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No arrancó el proceso de prueba")), 30000);
    const read = (bytes) => { const text = bytes.toString(); serverLog += text; const match = text.match(pattern); if (match) { clearTimeout(timer); resolve(match[0]); } };
    process.stdout?.on("data", read); process.stderr?.on("data", read);
    process.once("error", reject); process.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Proceso finalizado: ${code}`)); });
  });
}
try {
  await ready(server, /http:\/\/127\.0\.0\.1:42083/);
  const info = await api("/api/info");
  assert.equal(info.version, "2.3.0", "La prueba fija el cliente/servidor 2.3.0.");
  const created = await api("/api/session", { title: "IK revisión sintética", location: { directory: project }, permissions: [{ action: "jira.write", resource: "*", effect: "ask" }] });
  const sessionID = created.data.id;
  await api("/api/location");
  const configuration = await api("/api/config");
  await writeFile(join(root, "configured-plugins.json"), JSON.stringify(configuration.data?.plugins ?? configuration.plugins ?? [], null, 2));
  await api("/api/agent");
  await writeFile(join(root, "commands.json"), JSON.stringify(await api("/api/command"), null, 2));
  await writeFile(join(root, "plugins.json"), JSON.stringify(await api("/api/plugin"), null, 2));
  const review = `INICIO-REVISION-IK\nPropuesta sintética; no escribe en Jira.\n\n${Array.from({ length: 150 }, (_, index) => `Fila ${index + 1}: cuenta QA | audiencia interna | persona id-sintetico | valor aprobado ${index}`).join("\n")}\n\nFIN-REVISION-IK`;
  const permission = await api(`/api/session/${sessionID}/permission`, { action: "jira.write", resources: [`qa/issue/QA-1/change/comment/internal/${"a".repeat(64)}`], save: [`qa/issue/QA-1/change/comment/internal/${"a".repeat(64)}`], metadata: { title: "Revisión íntegra Jira", description: review, review, payloadHash: "a".repeat(64) } });
  assert.equal(permission.data.effect, "ask");
  const pending = await api(`/api/session/${sessionID}/permission`); assert.equal(pending.data.length, 1);
  await writeFile(join(root, "request.json"), JSON.stringify(pending, null, 2));
  chrome = spawn(process.env.CHROME_BIN ?? "google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${join(root, "chrome")}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
  const address = await ready(chrome, /ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[A-Za-z0-9-]+/);
  socket = new WebSocket(address); await once(socket, "open");
  let next = 0; const waiting = new Map(); let session; const browserEvents = [];
  socket.addEventListener("message", (message) => {
    const data = JSON.parse(message.data);
    if (["Runtime.exceptionThrown", "Network.loadingFailed", "Runtime.consoleAPICalled"].includes(data.method)) browserEvents.push(data);
    if (data.id && waiting.has(data.id)) { const waiter = waiting.get(data.id); waiting.delete(data.id); clearTimeout(waiter.timer); data.error ? waiter.reject(new Error(data.error.message)) : waiter.resolve(data.result); }
    if (data.method === "Fetch.requestPaused") {
      const { requestId, request } = data.params;
      browserEvents.push({ url: request.url, local: request.url.startsWith(base + "/") });
      const operation = request.url.startsWith(pathToFileURL(root).href + "/") ? cdp("Fetch.continueRequest", { requestId }) : request.url.startsWith(base + "/")
        ? cdp("Fetch.continueRequest", { requestId, headers: Object.entries({ ...request.headers, Authorization: headers.Authorization }).map(([name, value]) => ({ name, value })) })
        : cdp("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      void operation.catch(() => {});
    }
  });
  function cdp(method, params = {}, useSession = true) {
    const id = ++next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
      waiting.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(useSession && session ? { sessionId: session } : {}) }));
    });
  }
  const target = await cdp("Target.createTarget", { url: "about:blank" }, false);
  session = (await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true }, false)).sessionId;
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Network.enable");
  await cdp("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const route = `/server/${Buffer.from(base).toString("base64url")}/session/${sessionID}`;
  await cdp("Page.navigate", { url: base + route });
  await cdp("Runtime.evaluate", { expression: `new Promise(resolve => { const finish=()=>{const text=document.body?.innerText??'';if(text.includes('jira.write')||text.includes('Password')||text.includes('Connect to')||text.includes('Algo salió mal')){observer.disconnect();resolve(true)}};const observer=new MutationObserver(finish);observer.observe(document,{subtree:true,childList:true});setTimeout(()=>{observer.disconnect();resolve(false)},45000);finish() })`, awaitPromise: true });
  const ui = await cdp("Runtime.evaluate", { expression: `JSON.stringify({url:location.pathname,title:document.title,text:document.body.innerText,inputs:[...document.querySelectorAll('input,textarea')].map(e=>({type:e.type,placeholder:e.placeholder,value:e.value})),buttons:[...document.querySelectorAll('button')].map(e=>e.innerText)})`, returnByValue: true });
  await writeFile(join(root, "ui.json"), ui.result.value);
  const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(join(root, "screen.png"), Buffer.from(screenshot.data, "base64"));
  const document = JSON.parse(ui.result.value);
  const html = await cdp("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true });
  await writeFile(join(root, "document.html"), html.result.value);
  await writeFile(join(root, "browser-events.json"), JSON.stringify(browserEvents, null, 2));
  await api(`/api/session/${sessionID}/permission/${pending.data[0].id}/reply`, { decision: "reject" });
  const now = new Date().toISOString();
  const plan = { version: 1, id: "client-review", sessionID, locationID: "c".repeat(64), account: "qa", site: "https://synthetic.invalid", credentialIdentity: "synthetic-agent", issueId: "1", issueKey: "QA-1", projectKey: "QA", kind: "comment-with-attachments", audience: "internal", commentText: review, commentFormat: "plain", payload: { body: review }, summary: "Ensayo sintético sin emisión Jira", expectedUpdated: now, policyFingerprint: "d".repeat(64), createdAt: now, expiresAt: new Date(Date.now() + 600000).toISOString(), files: [{ stagedRef: "file-1", publishedName: "datos-ñ.bin", size: 1024, sha256: "a".repeat(64) }, { stagedRef: "file-2", publishedName: "vacio.txt", size: 0, sha256: "b".repeat(64) }], steps: [{ id: "step-1", kind: "mutation", fileRefs: ["file-1", "file-2"] }] };
  await writeFile(join(root, "plan.json"), JSON.stringify(plan));
  const full = changeReview(plan); const view = join(root, "review.html"); await writeFile(view, reviewHTML(full));
  await cdp("Page.navigate", { url: pathToFileURL(view).href });
  await cdp("Runtime.evaluate", { expression: `new Promise(resolve=>{const check=()=>{if(document.querySelector('#review')){observer.disconnect();resolve(true)}};const observer=new MutationObserver(check);observer.observe(document,{subtree:true,childList:true});setTimeout(()=>{observer.disconnect();resolve(false)},10000);check()})`, awaitPromise: true });
  const checked = await cdp("Runtime.evaluate", { expression: "JSON.stringify({text:document.querySelector('#review')?.textContent,hash:document.querySelector('#review-hash')?.textContent,height:document.documentElement.scrollHeight})", returnByValue: true });
  const safeView = JSON.parse(checked.result.value); assert.equal(safeView.text, full.text); assert.equal(safeView.hash, full.reviewHash);
  await cdp("Runtime.evaluate", { expression: "document.querySelector('#review-hash').scrollIntoView()" });
  const end = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); await writeFile(join(root, "review-bottom.png"), Buffer.from(end.data, "base64"));
  const command = api(`/api/session/${sessionID}/command`, { name: "ik-review-spike", text: "" }).then(() => ({ completed: true }), (error) => ({ rejected: true, reason: error.message }));
  let native;
  for (let attempt = 0; attempt < 100; attempt++) {
    const listed = await api(`/api/session/${sessionID}/permission`); if (listed.data.length) { native = listed.data[0]; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(native, JSON.stringify(await Promise.race([command, Promise.resolve({ pending: true })]))); assert.deepEqual(native.resources, [full.resource]); assert.deepEqual(native.save, [full.resource]);
  await writeFile(join(root, "sdk-request.json"), JSON.stringify(native, null, 2));
  await cdp("Page.navigate", { url: base + route });
  await cdp("Runtime.evaluate", { expression: `new Promise(resolve=>{const check=()=>{if(document.body?.innerText.includes(${JSON.stringify(full.payloadHash)})){observer.disconnect();resolve(true)}};const observer=new MutationObserver(check);observer.observe(document,{subtree:true,childList:true});setTimeout(()=>{observer.disconnect();resolve(false)},20000);check()})`, awaitPromise: true });
  const prompt = await cdp("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true }); assert(prompt.result.value.includes(full.payloadHash));
  await cdp("Runtime.evaluate", { expression: `(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true})()`, awaitPromise: true });
  const visibility = await cdp("Runtime.evaluate", { expression: `new Promise(resolve=>{let timer;const check=()=>{const e=document.querySelector('[data-slot="permission-patterns"] code');if(!e?.textContent.includes(${JSON.stringify(full.payloadHash)})||e.closest('[data-slot="composer-morph"]')?.hasAttribute('data-moving'))return;let opacity=1;for(let p=e;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden')return;opacity*=Number(s.opacity)}const b=e.getBoundingClientRect();if(opacity>.99&&b.width>0&&b.height>0&&b.top<innerHeight&&b.bottom>0){observer.disconnect();clearTimeout(timer);resolve(true)}};const observer=new MutationObserver(check);observer.observe(document,{subtree:true,childList:true,attributes:true});timer=setTimeout(()=>{observer.disconnect();resolve(false)},20000);check()})`, awaitPromise: true, returnByValue: true });
  const promptImage = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); await writeFile(join(root, "sdk-permission.png"), Buffer.from(promptImage.data, "base64"));
  assert.equal(visibility.result.value, true);
  await api(`/api/session/${sessionID}/permission/${native.id}/reply`, { decision: "reject" }); await command;
  const rules = [];
  for (const effect of ["allow", "deny"]) {
    const other = await api("/api/session", { title: `IK native ${effect}`, location: { directory: project }, permissions: [{ action: "jira.write", resource: full.resource, effect }] });
    const decision = await api(`/api/session/${other.data.id}/permission`, { action: "jira.write", resources: [full.resource], save: [full.resource] });
    assert.equal(decision.data.effect, effect);
    assert.equal((await api(`/api/session/${other.data.id}/permission`)).data.length, 0);
    rules.push({ effect, native: decision.data.effect, pending: 0 });
  }
  const sdk = JSON.parse(await readFile(new URL("../node_modules/@opencode/plugin/package.json", import.meta.url), "utf8")).version;
  const nativeStore = JSON.parse(await readFile(join(root, "native-store.json"), "utf8"));
  const verification = { version: info.version, sdk, sdkResolution: "host-provided @opencode/plugin", sessionID, nativePermission: true, source: "sdk-command-synthetic-spike", humanDecision: false, nativeMetadataVisible: document.text.includes("INICIO-REVISION-IK"), safeViewFullText: true, nativeExactHashVisibleAfterReview: true, reviewBytes: full.bytes, viewHeight: safeView.height, nativeStore, reviewBeforeNativePermission: true, rules };
  await writeFile(join(root, "verification.json"), JSON.stringify(verification, null, 2));
  console.log(JSON.stringify({ evidence: root, ...verification }));
} finally {
  socket?.close();
  if (chrome?.exitCode === null) { const exited = once(chrome, "exit"); chrome.kill("SIGTERM"); await exited; }
  if (server.exitCode === null) { const exited = once(server, "exit"); server.kill("SIGTERM"); await exited; }
  await writeFile(join(root, "server.log"), serverLog.replaceAll(password, "[redacted]"));
}
