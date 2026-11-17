import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { parseConfig } from "../dist/config.js";
import { Service } from "../dist/core/service.js";
import { JiraCloud } from "../dist/jira/cloud.js";
import { HttpClient } from "../dist/http.js";
import { planDownload, saveDownload } from "../dist/files.js";
import { registerReads } from "../dist/tools/reads.js";

const code = process.argv[2];
const codes = ["HT-01", "HT-02", "HT-03", "HT-04", "HT-05", "HT-06", "HT-07", "HT-08", "DE-06", "DE-07", "DE-08", "PE-06", "BU-04", "ME-05"];
assert.ok(codes.includes(code), `Uso: node scripts/lab-closure.mjs ${codes.join("|")}`);
process.umask(0o077);
process.env.IK_CLOSURE_SYNTHETIC = "synthetic-nonfunctional-credential";
const campaign = await mkdtemp("/tmp/opencode/issuekeeper-closure-");
const lifetime = setTimeout(() => { throw new Error("Presupuesto del laboratorio agotado"); }, 30000);
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const issue = (project = "LAB", key = "LAB-1") => ({ id: "1", key, fields: { project: { id: "10", key: project, projectTypeKey: "software" }, updated: "2026-01-01T00:00:00Z", summary: "Synthetic", status: { id: "1", name: "Open" } } });
const attachment = { id: "101", filename: "lab.bin", size: 5, mimeType: "application/octet-stream" };
const rawAccount = id => ({ id, siteUrl: "https://laboratory.atlassian.net", auth: { mode: "cloud-token", email: "lab@example.invalid", tokenEnv: "IK_CLOSURE_SYNTHETIC" }, restrictedProjects: ["OUT"] });
const config = options => parseConfig({ accounts: [rawAccount("direct"), rawAccount("other")], ...options });
const signal = () => new AbortController().signal;
const media = "https://api.media.atlassian.com/file/11111111-2222-4333-8444-555555555555/binary?token=synthetic";
let variants = 0;
const observed = (variant, evidence) => { variants++; console.log(JSON.stringify({ case: code, variant, status: "APROBADO", ...evidence, realJiraContacted: false })); };

async function laboratory(options, handler, run, hooks = {}) {
  const root = await mkdtemp(join(campaign, "case-"));
  const cfg = config(options);
  const events = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    events.push({ method: init.method, host: url.hostname, path: url.pathname, authenticated: new Headers(init.headers).has("authorization") });
    return handler(url, init, events);
  };
  const http = new HttpClient(cfg, fetcher);
  const provider = new JiraCloud(cfg, http);
  const service = await Service.create(cfg, root, provider);
  const tools = new Map();
  await registerReads({
    location: { directory: root },
    session: { get: async () => ({ location: { directory: hooks.location?.() ?? root } }) },
    tool: { transform: async callback => callback({ namespace() {}, add(tool) { tools.set(tool.name, tool); } }) },
    permission: { assert: async input => hooks.permission?.(input) },
  }, service);
  const invoke = async (name, args, abort = signal()) => {
    const result = await tools.get(name).execute(args, { sessionID: "lab", agent: "build", messageID: "lab-message", id: "lab-call", signal: abort });
    return JSON.parse(result.content);
  };
  try { await run({ cfg, root, events, http, provider, service, invoke }); }
  finally { service.close(); }
}

function downloadResponse(url, binary = () => new Response("hello")) {
  if (url.pathname.includes("/attachment/content/")) return binary();
  if (url.pathname.endsWith("/attachment/101")) return json(attachment);
  if (url.searchParams.get("fields") === "attachment,project") return json({ id: "1", fields: { project: issue().fields.project, attachment: [attachment] } });
  return json(issue());
}
const downloadInput = { account: "direct", issueKey: "LAB-1", attachmentId: "101" };

try {
  if (code === "HT-01") {
    for (const scoped of [false, true]) for (const jsm of [false, true]) {
      const account = { ...rawAccount("direct"), serviceManagement: { enabled: jsm } };
      if (scoped) account.auth = { ...account.auth, mode: "cloud-scoped-token", cloudId: "11111111-2222-4333-8444-555555555555" };
      await laboratory({ accounts: [account] }, url => url.pathname === "/_edge/tenant_info" ? json({ cloudId: account.auth.cloudId }) : json({}), async ({ http, cfg, events }) => {
        const path = jsm ? "rest/servicedeskapi/request/LAB-1/comment" : "rest/api/3/myself";
        await http.json(cfg.accounts[0], path, signal());
        assert.equal(events[0].host, scoped ? "api.atlassian.com" : "laboratory.atlassian.net");
        assert.equal(events[0].path, scoped ? `/ex/jira/${account.auth.cloudId}/${path}` : `/${path}`);
        observed(`${scoped ? "scoped" : "direct"}/${jsm ? "jsm" : "platform"}`, { events });
      });
    }
  }
  if (code === "HT-02") for (const status of [400, 401, 403, 404, 409, 413, 422]) {
    await laboratory({}, () => json({ private: "REMOTE-BODY-NOT-FOR-OUTPUT" }, status), async ({ invoke, events }) => {
      const result = await invoke("issue_get", { account: "direct", issueKey: "LAB-1" });
      assert.equal(result.ok, false); assert.equal(result.error.retryable, false); assert.equal(events.length, 1);
      assert.ok(!JSON.stringify(result).includes("REMOTE-BODY"));
      observed(String(status), { normalizedCode: result.error.code, attempts: events.length, requestId: result.meta.requestId });
    });
  }
  if (code === "HT-03") {
    for (const variant of ["retry-after", "budget", "persistent", "cancel"]) {
      const abort = new AbortController();
      await laboratory({ http: { timeoutMs: variant === "budget" ? 50 : 4000 } }, (_url, _init, events) => {
        if (variant === "cancel") abort.abort(new DOMException("Synthetic cancellation", "AbortError"));
        if (variant === "retry-after" && events.length > 1) return json(issue());
        return json({}, variant === "retry-after" || variant === "budget" ? 429 : 503, { "retry-after": variant === "retry-after" || variant === "budget" ? "1" : "0" });
      }, async ({ invoke, events }) => {
        const started = Date.now();
        if (variant === "cancel") await assert.rejects(invoke("issue_get", { account: "direct", issueKey: "LAB-1" }, abort.signal), e => e === abort.signal.reason);
        else {
          const result = await invoke("issue_get", { account: "direct", issueKey: "LAB-1" });
          assert.equal(result.ok, variant === "retry-after");
          if (variant === "retry-after") assert.ok(Date.now() - started >= 1000);
          if (variant === "budget") assert.equal(result.error.code, "RATE_LIMITED");
        }
        assert.equal(events.length, variant === "retry-after" ? 2 : variant === "persistent" ? 3 : 1);
        observed(variant, { attempts: events.length, durationMs: Date.now() - started });
      });
    }
  }
  if (code === "HT-04") for (const variant of ["html", "malformed", "oversized", "redirect"]) {
    await laboratory({ http: { maxResponseBytes: 128 } }, () => variant === "html" ? new Response("<html>login</html>", { headers: { "content-type": "text/html" } })
      : variant === "malformed" ? new Response("{broken", { headers: { "content-type": "application/json" } })
      : variant === "redirect" ? new Response(null, { status: 303, headers: { location: "https://invalid.example/signed" } }) : json({ value: "x".repeat(1024) }), async ({ invoke, events }) => {
      const result = await invoke("issue_get", { account: "direct", issueKey: "LAB-1" });
      assert.equal(result.ok, false); assert.equal(events.length, 1);
      observed(variant, { normalizedCode: result.error.code, events });
    });
  }
  if (code === "HT-05" || code === "BU-04") {
    for (const variant of ["short-then-empty", "repeated", "restricted"]) {
      await laboratory({}, (_url, init, events) => {
        const input = JSON.parse(init.body);
        assert.match(input.jql, /NOT IN/);
        if (variant === "restricted") return json({ issues: [issue("OUT")], isLast: true });
        if (events.length > 1 && variant !== "repeated") return json({ issues: [], isLast: true });
        return json({ issues: [issue()], isLast: false, nextPageToken: "continuation" });
      }, async ({ invoke, events }) => {
        const args = { account: "direct", jql: "project in (LAB, OUT) AND (summary ~ 'one' OR summary ~ 'two') ORDER BY key", maxResults: 2 };
        const first = await invoke("issues_search", args);
        assert.equal(first.ok, true);
        if (variant === "restricted") { assert.deepEqual(first.data.values, []); assert.ok(first.warnings.length); }
        else {
          assert.equal(first.data.isLast, false);
          const next = await invoke("issues_search", { ...args, cursor: first.data.cursor });
          if (variant === "repeated") assert.equal(next.error.code, "CURSOR_INVALID");
          else { assert.equal(next.ok, true); assert.equal(next.data.isLast, true); assert.deepEqual(next.data.values, []); }
        }
        observed(variant, { outboundCalls: events.length, resultsRestricted: variant === "restricted", shortPageContinued: variant === "short-then-empty" });
      });
    }
    if (code === "HT-05") await laboratory({ accounts: [{ ...rawAccount("direct"), serviceManagement: { enabled: true } }] }, url => {
      if (url.pathname.endsWith("/comment")) return json({ start: 0, limit: 2, size: 1, isLastPage: true, values: [{ id: "1", public: false, body: "INTERNAL-CANARY" }] });
      if (url.pathname.includes("/servicedeskapi/")) return json({ issueId: "1", issueKey: "LAB-1", serviceDeskId: "20", requestTypeId: "30", summary: "Synthetic request", currentStatus: { status: "Open" } });
      const ticket = issue(); ticket.fields.project.projectTypeKey = "service_desk"; return json(ticket);
    }, async ({ invoke }) => {
      const result = await invoke("comments_list", { account: "direct", issueKey: "LAB-1", audience: "public" });
      assert.equal(result.error.code, "INVALID_RESPONSE"); assert.ok(!JSON.stringify(result).includes("INTERNAL-CANARY"));
      observed("internal-on-public", { normalizedCode: result.error.code, internalTextDelivered: false });
    });
  }
  if (code === "HT-06") for (const variant of ["valid-media", "foreign-media", "http", "port", "userinfo", "path", "malformed-location", "redirect-chain"]) {
    await laboratory({}, (url, init) => {
      if (url.hostname === "api.media.atlassian.com") {
        assert.equal(new Headers(init.headers).has("authorization"), false);
        assert.equal(init.credentials, "omit");
        return variant === "redirect-chain" ? new Response(null, { status: 303, headers: { location: media } }) : new Response("hello");
      }
      const location = variant === "foreign-media" ? "https://private.invalid/binary" : variant === "http" ? media.replace("https:", "http:")
        : variant === "port" ? media.replace(".com/", ".com:444/") : variant === "userinfo" ? media.replace("https://", "https://user:password@")
        : variant === "path" ? "https://api.media.atlassian.com/arbitrary" : variant === "malformed-location" ? "not-a-url" : media;
      return new Response(null, { status: 303, headers: { location } });
    }, async ({ http, cfg, events }) => {
      const result = await http.read(cfg.accounts[0], "rest/servicedeskapi/request/LAB-1/attachment/101", signal(), r => r.text(), undefined, true).then(data => ({ data }), e => ({ code: e.code }));
      if (variant === "valid-media") assert.equal(result.data, "hello"); else assert.equal(result.code, "REDIRECT_NOT_ALLOWED");
      assert.equal(events.length, variant === "valid-media" || variant === "redirect-chain" ? 2 : 1);
      observed(variant, { result: result.code ?? "OK", events });
    });
  }
  if (code === "HT-07") {
    for (const action of ["jira.read", "jira.download", "edit"]) {
      const denied = new Error(`Native denial: ${action}`);
      await laboratory({}, downloadResponse, async ({ invoke, events, root }) => {
        await assert.rejects(invoke("attachment_download", downloadInput), e => e === denied);
        assert.ok(!events.some(e => e.path.includes("/attachment/content/")));
        assert.deepEqual(await readdir(root), []);
        observed(`deny-${action}`, { nativeRejection: true, contentRequests: 0, metadataRequests: events.length });
      }, { permission: input => { if (input.action === action) throw denied; } });
    }
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { started = resolve; });
    let active = 0, maximum = 0;
    await laboratory({ http: { maxConcurrentPerAccount: 1 } }, async (_url, _init, events) => {
      active++; maximum = Math.max(maximum, active);
      if (events.length === 1) { started(); await gate; }
      active--; return json({});
    }, async ({ http, cfg, events }) => {
      const first = http.json(cfg.accounts[0], "rest/api/3/myself", signal()); await ready;
      const abort = new AbortController();
      const second = http.json(cfg.accounts[1], "rest/api/3/myself", abort.signal);
      const rejected = assert.rejects(second, e => e === abort.signal.reason);
      await tick(); abort.abort(new DOMException("Cancel queued read", "AbortError")); await rejected;
      release(); await first;
      await http.json(cfg.accounts[1], "rest/api/3/myself", signal());
      assert.equal(maximum, 1); assert.equal(events.length, 2);
      observed("shared-site-queue", { maximumConcurrent: maximum, cancelledBeforeDispatch: true, laterReadSucceeded: true });
    });
  }
  if (code === "HT-06") for (const bytes of ["hel", "hello extra"]) {
    const root = await mkdtemp(join(campaign, "size-"));
    const directory = join(root, "downloads");
    await assert.rejects(saveDownload(new Response(bytes), planDownload(directory, "size.bin", "101"), root, 5, 20, signal()), { code: "TRANSFER_INCOMPLETE" });
    assert.deepEqual(await readdir(directory), []);
    observed(bytes.length < 5 ? "short-stream" : "long-stream", { expectedBytes: 5, receivedBytes: bytes.length, finalFiles: 0 });
  }
  if (code === "ME-05") {
    let allowed = true;
    await laboratory({}, url => {
      if (!allowed) return json({}, 404);
      if (url.pathname.endsWith("viewissue/search")) return json([{ accountId: "person", displayName: "Ana synthetic" }]);
      return json(issue());
    }, async ({ invoke }) => {
      const input = { account: "direct", issueKey: "LAB-1", audience: "ticket", query: "Ana", maxResults: 2 };
      const first = await invoke("mention_candidates", input);
      assert.equal(first.data.values[0].validation, "validated");
      allowed = false;
      const second = await invoke("mention_candidates", input);
      assert.equal(second.error.code, "NOT_FOUND_OR_NO_ACCESS");
      assert.ok(!JSON.stringify(second).includes("Ana synthetic"));
      observed("permissions-revoked", { previouslyValidated: true, staleCandidateDelivered: false, normalizedCode: second.error.code });
    });
  }
  if (code === "HT-08") {
    for (const errorCode of ["ENOSPC", "EIO"]) {
      const root = await mkdtemp(join(campaign, "storage-"));
      const probe = await open(join(root, "probe"), "wx", 0o600);
      const prototype = Object.getPrototypeOf(probe); await probe.close();
      const original = prototype.write;
      await writeFile(join(root, "control.txt"), "CONTROL");
      prototype.write = async function (...args) {
        const { readlink } = await import("node:fs/promises");
        if ((await readlink(`/proc/self/fd/${this.fd}`)).startsWith(root + "/")) throw Object.assign(new Error("Synthetic storage failure"), { code: errorCode });
        return original.apply(this, args);
      };
      try {
        const destination = join(root, "downloads");
        await assert.rejects(saveDownload(new Response("hello"), planDownload(destination, "lab.bin", "101"), root, 5, 5, signal()), { code: "TRANSFER_INCOMPLETE" });
        assert.deepEqual(await readdir(destination), []); assert.equal(await readFile(join(root, "control.txt"), "utf8"), "CONTROL");
        observed(errorCode, { finalFiles: 0, temporaryFiles: 0, controlIntact: true });
      } finally { prototype.write = original; }
    }
    const root = await mkdtemp(join(campaign, "collision-")), destination = join(root, "downloads");
    const results = await Promise.allSettled([1, 2].map(() => saveDownload(new Response("hello"), planDownload(destination, "lab.bin", "101"), root, 5, 5, signal())));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.deepEqual(await readdir(destination), ["101-lab.bin"]);
    observed("concurrent-collision", { completeFiles: 1, rejectedPublishers: 1 });
    const moved = join(root, "moved");
    const body = new ReadableStream({ async pull(controller) { await rename(destination, moved); controller.enqueue(new TextEncoder().encode("hello")); controller.close(); } }, { highWaterMark: 0 });
    await assert.rejects(saveDownload(new Response(body), planDownload(destination, "new.bin", "102"), root, 5, 5, signal()));
    assert.deepEqual(await readdir(moved), ["101-lab.bin"]);
    observed("directory-moved", { newFilePublished: false, previousDownloadIntact: await readFile(join(moved, "101-lab.bin"), "utf8") === "hello" });
    await symlink(moved, destination);
    await assert.rejects(saveDownload(new Response("hello"), planDownload(destination, "new.bin", "103"), root, 5, 5, signal()), { code: "FILE_ACCESS_DENIED" });
    assert.deepEqual(await readdir(moved), ["101-lab.bin"]);
    observed("symlink-directory", { decoyUnchanged: true });
    const safe = join(root, "safe"); await mkdir(safe, { mode: 0o700 });
    const decoy = join(root, "decoy.txt"); await writeFile(decoy, "PRESERVE");
    await symlink(decoy, join(safe, "104-link.bin"));
    await assert.rejects(saveDownload(new Response("hello"), planDownload(safe, "link.bin", "104"), root, 5, 5, signal()), { code: "FILE_ACCESS_DENIED" });
    assert.equal(await readFile(decoy, "utf8"), "PRESERVE");
    observed("symlink-final", { decoyUnchanged: true });
  }
  if (["DE-06", "DE-07", "DE-08", "PE-06"].includes(code)) {
    if (code === "PE-06") {
      const denied = new Error("Native canonical key denial");
      await laboratory({}, () => json(issue("LAB", "LAB-2")), async ({ invoke, events }) => {
        await assert.rejects(invoke("issue_get", { account: "direct", issueKey: "LAB-1" }), e => e === denied);
        assert.equal(events.length, 1);
        observed("canonical-resource", { originalPermissionPassed: true, canonicalPermissionDenied: true, nativeRejection: true, ticketDelivered: false });
      }, { permission: input => { if (input.resources.includes("direct/issue/LAB-2")) throw denied; } });
    } else if (code === "DE-08") {
      let moved = false;
      await laboratory({}, downloadResponse, async ({ invoke, root, events }) => {
        const result = await invoke("attachment_download", downloadInput);
        assert.equal(result.error.code, "FILE_ACCESS_DENIED"); assert.deepEqual(await readdir(root), []);
        assert.ok(!events.some(e => e.path.includes("/attachment/content/")));
        observed("move-during-edit-approval", { normalizedCode: result.error.code, contentRequests: 0, localFiles: 0 });
      }, { permission: input => { if (input.action === "edit") moved = true; }, location: () => moved ? campaign : undefined });
    } else if (code === "DE-07") {
      for (const variant of ["cancel-after-bytes", "interrupted-stream", "timeout", "after-success"]) {
        const abort = new AbortController(); let consumed = false;
        await laboratory({ attachments: { transferTimeoutMs: variant === "timeout" ? 100 : 4000 } }, url => downloadResponse(url, () => {
          if (variant === "after-success") return new Response("hello");
          return new Response(new ReadableStream({
            pull(controller) {
              if (!consumed) { consumed = true; controller.enqueue(new TextEncoder().encode("he")); return; }
              else if (variant === "cancel-after-bytes") abort.abort(new DOMException("Cancel after receiving bytes", "AbortError"));
              else if (variant === "interrupted-stream") controller.error(new Error("Synthetic interrupted stream"));
              return new Promise(() => {});
            },
          }, { highWaterMark: 0 }));
        }), async ({ root, invoke, events }) => {
          const directory = join(root, ".issuekeeper/downloads"); await mkdir(directory, { recursive: true, mode: 0o700 });
          const control = await saveDownload(new Response("control"), planDownload(directory, "control.bin", "999"), root, 7, 7, signal());
          if (variant === "cancel-after-bytes") await assert.rejects(invoke("attachment_download", downloadInput, abort.signal), e => e === abort.signal.reason);
          else {
            const result = await invoke("attachment_download", downloadInput, abort.signal);
            if (variant === "after-success") { assert.equal(result.ok, true); abort.abort(); assert.equal(await readFile(join(root, result.data.path), "utf8"), "hello"); }
            else assert.equal(result.error.code, variant === "timeout" ? "TIMEOUT" : "TRANSFER_INCOMPLETE");
          }
          assert.equal(await readFile(join(root, control.path), "utf8"), "control");
          assert.deepEqual((await readdir(directory)).sort(), variant === "after-success" ? ["101-lab.bin", "999-control.bin"] : ["999-control.bin"]);
          assert.ok(events.some(e => e.path.includes("/attachment/content/")));
          observed(variant, { binaryRequested: true, bytesReceivedBeforeFailure: consumed, noPartialFinal: true, controlDownloadIntact: true });
        });
      }
    } else {
      const large = { ...attachment, size: 2048 };
      await laboratory({ http: { maxResponseBytes: 1024 }, attachments: { maxFileBytes: 2048 } }, url => {
        if (url.pathname.includes("/attachment/content/")) return new Response("x".repeat(2048));
        if (url.pathname.endsWith("/attachment/101")) return json(large);
        if (url.searchParams.get("fields") === "attachment,project") return json({ id: "1", fields: { project: issue().fields.project, attachment: [large] } });
        return json(issue());
      }, async ({ invoke }) => {
        const result = await invoke("attachment_download", downloadInput);
        assert.equal(result.ok, true); assert.equal(result.data.size, 2048); observed("json-independent", { jsonBudget: 1024, binarySize: result.data.size, sha256: result.data.sha256 });
      });
      const root = await mkdtemp(join(campaign, "limit-"));
      await assert.rejects(saveDownload(new Response("123456"), planDownload(join(root, "downloads"), "over.bin", "101"), root, 5, 5, signal()), { code: "ATTACHMENT_TOO_LARGE" });
      assert.deepEqual(await readdir(join(root, "downloads")), []);
      observed("actual-bytes-exceed-limit", { finalFiles: 0, temporaryFiles: 0 });
    }
  }
  console.log(JSON.stringify({ case: code, completedVariants: variants, result: "APROBADO", syntheticCredentialsOnly: true, realJiraContacted: false }));
} finally {
  clearTimeout(lifetime);
  await rm(campaign, { recursive: true, force: true });
  delete process.env.IK_CLOSURE_SYNTHETIC;
}
