import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function mutationTarget(accounts, targets, input, method) {
  const url = new URL(String(input));
  assert(!url.username && !url.password && !url.hash && !url.search, "Mutation URL must be canonical");
  for (const target of targets) {
    const account = accounts.find((item) => item.id === target.account);
    assert(account, "Unknown campaign account");
    const prefix = account.auth.mode === "cloud-scoped-token" ? `/ex/jira/${account.auth.cloudId}` : "";
    const origin = prefix ? "https://api.atlassian.com" : new URL(account.siteUrl).origin;
    if (url.origin !== origin) continue;
    const path = url.pathname;
    const issue = `${prefix}/rest/api/3/issue/${target.issueKey}`;
    const request = `${prefix}/rest/servicedeskapi/request/${target.issueKey}`;
    if (method === "PUT" && path === issue || method === "POST" && [issue + "/comment", issue + "/transitions", issue + "/attachments", request + "/comment", request + "/attachment"].includes(path)
      || method === "POST" && target.serviceDeskId && path === `${prefix}/rest/servicedeskapi/servicedesk/${target.serviceDeskId}/attachTemporaryFile`) return target;
  }
  throw new Error("Mutation outside the authorized fixtures");
}

export function campaignResult(evidence) {
  const pending = evidence.variants.filter((item) => item.status !== "passed");
  const uncertain = evidence.ledger.filter((item) => !["confirmed", "rejected"].includes(item.state)).length;
  const unresolvedExecutions = evidence.variants.filter((item) => item.execution && ["applying", "unknown"].includes(item.execution.state)).length;
  return {
    automatic: evidence.variants.length > 0 && pending.length === 0 && !evidence.failure && uncertain === 0 && unresolvedExecutions === 0 ? "passed" : "incomplete",
    // Instrumented SDK callbacks are not native client decisions.
    humanDecision: false,
    G3: "pending", G4: "pending",
    mutations: evidence.ledger.length,
    uncertain,
    unresolvedExecutions,
  };
}

export async function runCampaign({ installed, configuration, manifest, output, authorized, verifyPublished }) {
  assert(authorized === true, "Explicit QA authorization required");
  assert(isAbsolute(output) && isAbsolute(installed), "Use absolute isolated paths");
  assert(manifest.version === 1 && Array.isArray(manifest.targets) && manifest.targets.length > 0);
  assert(Number.isSafeInteger(manifest.maxMutations) && manifest.maxMutations > 0 && manifest.maxMutations <= 100);
  assert(Array.isArray(manifest.scenarios) && manifest.scenarios.length > 0);
  for (const target of manifest.targets) {
    assert(/^[a-z][a-z0-9_-]*$/.test(target.account) && /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/.test(target.issueKey));
    assert(!target.serviceDeskId || /^\d+$/.test(target.serviceDeskId));
    const account = configuration.accounts.find((item) => item.id === target.account);
    assert(account && new URL(account.siteUrl).origin === target.site, "Fixture site differs from the credential account");
  }
  const known = new Set();
  for (const scenario of manifest.scenarios) {
    assert(/^[a-zA-Z0-9_-]{1,100}$/.test(scenario.id) && !known.has(scenario.id)); known.add(scenario.id);
    assert(manifest.targets.some((target) => target.account === scenario.account && target.issueKey === scenario.issueKey));
    assert(["fields", "transition", "comment", "upload", "metadata"].includes(scenario.kind));
    assert(!scenario.input || !["account", "issueKey", "expectedUpdated", "proposalId"].some((key) => Object.hasOwn(scenario.input, key)));
    assert(!scenario.expectError || typeof scenario.expectError === "string");
    assert(!scenario.expectMetadataError || scenario.kind === "metadata" && typeof scenario.expectMetadataError === "string");
    assert(scenario.modifyOriginalAfterPreparation === undefined || scenario.kind === "upload" && scenario.modifyOriginalAfterPreparation === true);
  }
  process.umask(0o077);
  // An existing directory is never a new campaign: it may contain an uncertain send.
  await mkdir(output, { mode: 0o700 });
  const load = (name) => import(pathToFileURL(join(installed, "dist", `${name}.js`)).href);
  const require = createRequire(join(installed, "package.json"));
  const Database = require("better-sqlite3");
  const { ChangeStore } = await load("state/store");
  const { userDataDirectory, statePaths } = await load("state/paths");
  const { changeReview, reviewHTML } = await load("core/review");
  const data = userDataDirectory();
  const contained = (parent, child) => { const rel = relative(parent, child); return rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"); };
  assert(contained(output, data), "Runtime must be private to this campaign; set XDG_DATA_HOME before starting");
  const location = join(output, "project"); await mkdir(join(location, "exports"), { recursive: true, mode: 0o700 });
  const options = structuredClone(configuration);
  options.accounts = options.accounts.filter((account) => manifest.targets.some((target) => target.account === account.id)).map((account) => ({ ...account, readOnly: false }));
  if (!options.accounts.some((account) => account.id === options.defaultAccount)) delete options.defaultAccount;
  options.attachments = { ...options.attachments, enabled: true, uploadRoots: ["exports"], downloadDir: "exports/downloads" };
  options.http = { ...options.http, readMaxAttempts: 1 };
  const packageBytes = await readFile(join(installed, "package.json"));
  const evidence = { version: 1, startedAt: new Date().toISOString(), packageVersion: JSON.parse(packageBytes).version, packageManifestHash: createHash("sha256").update(packageBytes).digest("hex"), artifactHash: manifest.artifactHash, modality: "REAL", permissionDriver: "instrumented-sdk-callback", humanDecision: false, retentionReview: manifest.retentionReview, targets: manifest.targets, variants: [], permissions: [], ledger: [], proposals: [] };
  const save = async () => writeFile(join(output, "verification.json"), JSON.stringify({ ...evidence, result: campaignResult(evidence) }, null, 2) + "\n", { mode: 0o600 });
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  const fetcher = globalThis.fetch; const tools = new Map(); let active; let approved; let cleanup;
  const sent = new Set();
  globalThis.fetch = async (input, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    if (["GET", "HEAD"].includes(method)) return fetcher(input, init);
    const target = mutationTarget(options.accounts, manifest.targets.filter((target) => target.account === active?.account), input, method);
    assert(evidence.ledger.length < manifest.maxMutations, "Mutation budget exhausted");
    assert(active && target.account === active.account && target.issueKey === active.issueKey, "Wrong active fixture");
    assert(approved, "No instrumented exact-resource permission");
    const db = new Database(statePaths(data).database, { readonly: true }); let sending;
    try { sending = db.prepare("SELECT document FROM executions WHERE id=?").get(approved.proposalId); }
    finally { db.close(); }
    const execution = JSON.parse(sending.document);
    const steps = execution.steps.filter((step) => step.state === "sending"); assert.equal(steps.length, 1, "sending must be durable before transport");
    const key = `${approved.proposalId}/${steps[0].id}`; assert(!sent.has(key), "A step must never be resent"); sent.add(key);
    const entry = { scenario: active.id, proposalId: approved.proposalId, step: steps[0].id, method, state: "sending", at: new Date().toISOString() };
    evidence.ledger.push(entry); await save();
    try {
      const response = await fetcher(input, init);
      entry.status = response.status; entry.state = response.ok ? "confirmed" : "rejected"; await save(); return response;
    } catch { entry.state = "unknown"; await save(); throw new Error("Uncertain QA mutation; do not resend"); }
  };
  const sessionID = `campaign-${randomUUID()}`;
  async function invoke(name, input) {
    const tool = tools.get(name); assert(tool, `Missing tool ${name}`);
    return JSON.parse((await tool.execute(input, { sessionID, agent: "build", messageID: randomUUID(), id: randomUUID(), signal: AbortSignal.timeout(180000), progress: async () => {} })).content);
  }
  async function stored(id) { const store = new ChangeStore(data); try { return store.get(id); } finally { store.close(); } }
  try {
    const { default: plugin } = await load("index");
    cleanup = await plugin.setup({ options, location: { directory: location }, session: { get: async () => ({ id: sessionID, location: { directory: location } }) },
      permission: { assert: async (request) => {
        evidence.permissions.push({ scenario: active?.id, action: request.action, resources: request.resources });
        if (request.action === "jira.write") {
          assert(approved && request.resources.length === 1 && request.resources[0] === approved.resource);
          assert.deepEqual(request.save, request.resources);
        }
        await save();
      } }, tool: { transform: async (callback) => callback({ namespace() {}, add(tool) { tools.set(tool.name, tool); } }) } });
    assert.equal(tools.size, 15);
    for (const scenario of manifest.scenarios) {
      active = scenario; approved = undefined;
      const variant = { id: scenario.id, cases: scenario.cases ?? [], account: scenario.account, issueKey: scenario.issueKey, kind: scenario.kind, status: "running", startedAt: new Date().toISOString() };
      evidence.variants.push(variant); await save();
      const metadata = await invoke("issue_edit_metadata", { account: scenario.account, issueKey: scenario.issueKey });
      if (scenario.expectMetadataError) {
        assert.equal(metadata.ok, false); assert.equal(metadata.error.code, scenario.expectMetadataError);
        variant.errorCode = metadata.error.code;
      } else if (scenario.kind === "metadata") {
        assert.equal(metadata.ok, true, `Metadata failed: ${metadata.error?.code}`);
        const transitions = await invoke("transitions_list", { account: scenario.account, issueKey: scenario.issueKey });
        assert.equal(transitions.ok, true);
        variant.fields = metadata.data.fields; variant.transitions = transitions.data.transitions;
      } else {
        assert.equal(metadata.ok, true, `Metadata failed: ${metadata.error?.code}`);
        const tool = { fields: "issue_update_prepare", transition: "transition_prepare", comment: "comment_prepare", upload: "attachment_upload_prepare" }[scenario.kind];
        const input = structuredClone(scenario.input ?? {});
        if (scenario.kind === "upload") {
          assert(Array.isArray(scenario.fixtures) && scenario.fixtures.length > 0);
          input.files = [];
          for (const file of scenario.fixtures) {
            assert(/^[\p{L}\p{N}_.😀-]+$/u.test(file.name) && ![".", ".."].includes(file.name));
            assert(["empty", "binary", "text"].includes(file.kind));
            const bytes = file.kind === "empty" ? Buffer.alloc(0) : file.kind === "binary" ? Buffer.from([0, 1, 2, 128, 254, 255, 13, 10]) : Buffer.from(`IssueKeeper QA ${scenario.id} 😀\r\n`);
            await writeFile(join(location, "exports", file.name), bytes, { mode: 0o600, flag: "wx" });
            input.files.push({ path: `exports/${file.name}` });
          }
        }
        const before = evidence.ledger.length;
        const prepared = await invoke(tool, { account: scenario.account, issueKey: scenario.issueKey, expectedUpdated: metadata.data.updated, ...input });
        assert.equal(evidence.ledger.length, before, "Preparation must never mutate remotely");
        if (scenario.expectError) {
          assert.equal(prepared.ok, false); assert.equal(prepared.error.code, scenario.expectError);
          variant.errorCode = prepared.error.code;
        } else {
          assert.equal(prepared.ok, true, `Preparation failed: ${prepared.error?.code}`);
          const saved = await stored(prepared.data.proposalId); const review = changeReview(saved.plan);
          evidence.proposals.push({ proposalId: saved.plan.id, payloadHash: saved.payloadHash, scenario: scenario.id });
          await writeFile(join(output, `${scenario.id}-review.html`), reviewHTML(review), { mode: 0o600, flag: "wx" });
          const store = new ChangeStore(data);
          try { store.acknowledgeReview(saved.plan.id, saved.execution.revision, review.reviewHash); } finally { store.close(); }
          if (scenario.modifyOriginalAfterPreparation) {
            for (const file of scenario.fixtures) await writeFile(join(location, "exports", file.name), "Synthetic source changed after staging; must never replace approved bytes.\n", { mode: 0o600 });
            variant.originalChangedAfterPreparation = true;
          }
          approved = { proposalId: saved.plan.id, resource: review.resource };
          await save();
          const applied = await invoke("change_apply", { proposalId: saved.plan.id });
          variant.application = applied;
          const after = await stored(saved.plan.id);
          variant.execution = after.execution; variant.receipts = after.receipts;
          assert.equal(after.payloadHash, saved.payloadHash);
          assert.equal(applied.ok, true, `Application failed: ${applied.error?.code}`);
          assert.equal(applied.data.state, "applied", "Unverified or uncertain operation; preserve evidence and stop");
          assert.equal(evidence.ledger.length - before, saved.plan.steps.length);
          const count = evidence.ledger.length;
          const repeated = await invoke("change_apply", { proposalId: saved.plan.id });
          assert.equal(repeated.data.state, "applied"); assert.equal(evidence.ledger.length, count);
          assert.equal((await stored(saved.plan.id)).payloadHash, saved.payloadHash);
          variant.deduplicated = true;
          if (verifyPublished) variant.representation = await verifyPublished({ saved: after, scenario });
        }
      }
      variant.status = "passed"; variant.finishedAt = new Date().toISOString(); await save();
    }
  } catch (error) {
    evidence.failure = error.name === "AssertionError" ? error.message : "Campaign interrupted; inspect private state, never resend blindly";
    const variant = evidence.variants.at(-1); if (variant?.status === "running") variant.status = "failed";
  } finally {
    try { await cleanup?.(); } finally { globalThis.fetch = fetcher; evidence.finishedAt = new Date().toISOString(); await save(); }
  }
  return { output, ...campaignResult(evidence) };
}

async function main() {
  const [installed, configPath, manifestPath, output, authorization] = process.argv.slice(2);
  assert(authorization === "--qa-authorized", "Usage: phase2-campaign.mjs PACKAGE CONFIG MANIFEST OUTPUT --qa-authorized");
  const packagePath = await realpath(resolve(installed));
  const require = createRequire(join(packagePath, "package.json"));
  const { parse } = require("jsonc-parser");
  const config = parse(await readFile(configPath, "utf8"));
  const plugins = config.plugins?.filter((item) => item && typeof item === "object" && item.package?.includes("opencode-jira")); assert.equal(plugins?.length, 1);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const result = await runCampaign({ installed: packagePath, configuration: plugins[0].options, manifest, output: resolve(output), authorized: true });
  console.log(JSON.stringify(result)); if (result.automatic !== "passed") process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
