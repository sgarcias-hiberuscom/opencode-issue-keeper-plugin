import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const variant = process.argv[2];
if (variant === undefined) {
  const results = await Promise.all(["tarball", "local", "registry"].map((source) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), source], { stdio: "inherit", timeout: 240000 });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ source, code, signal }));
  })));
  for (const result of results) assert.equal(result.code, 0, `Smoke ${result.source} incompleto (${result.signal ?? result.code}).`);
  console.log("Entrega aislada: quince herramientas, CLI local/tgz/registro, actualización compatible, apply protegido/deduplicado y conservación tras retirada comprobados.");
  process.exit(0);
}
assert(["tarball", "local", "registry"].includes(variant), "Variante de empaquetado desconocida.");

const directory = await mkdtemp("/tmp/opencode/issuekeeper-pack-");
try {
  // Keep the populated cache when isolated homes change npm's default cache path.
  const cache = execFileSync("npm", ["config", "get", "cache"], { encoding: "utf8", timeout: 10000 }).trim();
  const npmEnv = { ...process.env, npm_config_cache: cache, npm_config_legacy_peer_deps: "true", npm_config_fetch_retries: "0", npm_config_fetch_timeout: "15000", npm_config_update_notifier: "false" };
  const result = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { encoding: "utf8", env: npmEnv, timeout: 20000 }));
  const packed = Array.isArray(result) ? result[0] : Object.values(result)[0];
  const files = packed.files.map((file) => file.path);
  for (const required of ["dist/index.js", "dist/cli.js", "dist/uploads.js", "dist/state/staging.js", "dist/state/store.js", "dist/state/coordinator.js", "dist/state/application.js", "dist/state/runtime.js", "dist/state/multipart.js", "dist/state/review.js", "dist/state/operator.js", "dist/core/markdown.js", "dist/core/comment.js", "dist/core/adf-document.js", "dist/jira/mutations.js", "dist/jira/changes.js", "dist/jira/preparation.js", "dist/jira/attachment-links.js", "dist/tools/changes.js", "dist/tools/shared.js", "dist/tools/change-schemas.js", "options.schema.json", "templates/jira.md", "templates/account.example.jsonc", "templates/commands/jira-get.md", "templates/commands/jira-list.md", "templates/commands/jira-update.md"]) assert(files.includes(required));
  assert(files.every((file) => /^(?:dist\/|templates\/|README\.md$|LICENSE$|CHANGELOG\.md$|SECURITY\.md$|options\.schema\.json$|opencode\.example\.jsonc$|package\.json$)/.test(file)));
  const scanned = join(directory, "tarball-scan");
  await mkdir(scanned);
  const entries = execFileSync("tar", ["-tzf", join(directory, packed.filename)], { encoding: "utf8", timeout: 10000 }).split("\n").filter(Boolean);
  assert(entries.length > 0);
  execFileSync("tar", ["-xzf", join(directory, packed.filename), "-C", scanned], { timeout: 10000 });
  const forbiddenPath = /(token|secret|\.sqlite|\.env|reports\/|validation\/|\.issuekeeper)/i;
  const forbiddenContent = ["ATATT", "-----BEGIN", "Authorization: Basic", "X-Amz-Signature"];
  for (const entry of entries) {
    assert(!forbiddenPath.test(entry), `Ruta no permitida en el paquete: ${entry}`);
    if (entry.endsWith("/")) continue;
    const content = await readFile(join(scanned, entry), "latin1");
    for (const marker of forbiddenContent) assert(!content.includes(marker), `Contenido no permitido en ${entry}`);
  }
  await rm(scanned, { recursive: true, force: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const archive = join(directory, packed.filename);
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive], { cwd: directory, stdio: "pipe", env: npmEnv, timeout: 90000 });
  const installed = join(directory, "node_modules/@issuekeeper/opencode-jira");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert(!manifest.scripts.postinstall && !manifest.scripts.install);
  assert((await readFile(join(installed, "dist/cli.js"), "utf8")).startsWith("#!/usr/bin/env node"));
  assert.equal(await realpath(join(directory, "node_modules/.bin/issuekeeper-jira")), join(installed, "dist/cli.js"));
  const sdk = JSON.parse(await readFile(join(directory, "node_modules/@opencode/plugin/package.json"), "utf8"));
  const uiPeers = ["@opencode/theme", "@opentui/core", "@opentui/solid", "electron", "solid-js", "vite", "vite-plugin-solid"];
  for (const peer of uiPeers) {
    assert.equal(sdk.peerDependenciesMeta[peer].optional, true);
    assert(!existsSync(join(directory, "node_modules", peer, "package.json")));
  }
  const { default: plugin } = await import(pathToFileURL(join(installed, manifest.exports["."])).href);
  assert.equal(plugin.id, "issuekeeper.jira");
  const tools = [];
  const cleanup = await plugin.setup({
    location: { directory },
    options: { accounts: [] },
    tool: { transform: async (callback) => callback({ namespace() {}, add(tool) { tools.push(tool); } }) },
    permission: { assert: async () => { throw new Error("No execution expected during plugin setup"); } },
  });
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "accounts_list", "attachment_download", "attachment_upload_prepare", "attachments_list", "change_apply", "comment_prepare", "comments_list", "connection_test", "issue_edit_metadata", "issue_get", "issue_update_prepare", "issues_search", "mention_candidates", "transition_prepare", "transitions_list",
  ]);
  assert(!tools.some((tool) => /^(?:http|upload|request|reconcile)$/.test(tool.name)));
  await cleanup?.();
  const { install, check, uninstall } = await import(pathToFileURL(join(installed, "dist/installer/index.js")).href);
  const { installerPaths } = await import(pathToFileURL(join(installed, "dist/installer/paths.js")).href);
  const { ChangeStore } = await import(pathToFileURL(join(installed, "dist/state/store.js")).href);
  const { statePaths } = await import(pathToFileURL(join(installed, "dist/state/paths.js")).href);
  const { parseMarkdown } = await import(pathToFileURL(join(installed, "dist/core/markdown.js")).href);
  const markdown = "😀\r\n\r\n| A | B |\r\n| --- | --- |\r\n| uno | dos |";
  const parsedMarkdown = parseMarkdown(markdown);
  assert.equal(parsedMarkdown.source, markdown); assert(parsedMarkdown.ast.children.some((node) => node.type === "table"));
  const { publication } = await import(pathToFileURL(join(installed, "dist/core/comment.js")).href);
  const converted = publication("Hola **Ana**", "markdown", [{ start: 7, end: 10, accountId: "synthetic-person", displayName: "Ana" }], "jsm");
  assert(converted.wiki.includes("[~accountid:synthetic-person]"));
  assert(JSON.stringify(converted.adf).includes('"type":"mention"'));
  const io = { accept: async () => true, print() {} };
  const functional = join(directory, "functional-smoke.mjs");
  await copyFile(new URL("./package-functional-smoke.mjs", import.meta.url), functional);
  globalThis.fetch = async () => { throw new Error("Jira network is prohibited during installation"); };
  for (const source of variant === "registry" ? [] : [variant === "local" ? "local" : archive]) {
    const home = join(directory, source === "local" ? "local home" : "tarball home");
    const env = { ...npmEnv, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data") };
    const paths = installerPaths(env);
    await install(source, io, { paths });
    assert.equal(await check(io, paths), 0);
    const configPath = join(paths.config, "opencode.jsonc");
    const before = await readFile(configPath, "utf8");
    const copy = JSON.parse(before).plugins[0].package;
    const sqlite = JSON.parse(await readFile(join(copy, "..", "..", "better-sqlite3", "package.json"), "utf8"));
    assert.equal(sqlite.version, "13.2.0");
    assert(!sqlite.scripts?.install && !sqlite.scripts?.postinstall && !sqlite.scripts?.preinstall);
    const state = statePaths(paths.data);
    assert(!state.directory.startsWith(copy));
    assert(existsSync(state.database));
    const { ChangeStore: CopiedStore } = await import(pathToFileURL(join(copy, "dist/state/store.js")).href);
    const stamp = new Date();
    const created = stamp.toISOString();
    const expires = new Date(stamp.getTime() + 600000).toISOString();
    const store = new ChangeStore(paths.data, { now: () => stamp });
    assert.throws(() => new CopiedStore(paths.data), /Otra operación/);
    const { stageUploadFiles } = await import(pathToFileURL(join(copy, "dist/state/staging.js")).href);
    const location = join(directory, "project");
    await mkdir(join(location, "exports"), { recursive: true, mode: 0o700 });
    const origin = join(location, "exports", "sample.txt");
    await writeFile(origin, "Synthetic staged bytes", { mode: 0o600 });
    let readPermissions = 0;
    const staged = await stageUploadFiles(store, [{ path: origin, publishedName: "sample.txt" }], {
      location, uploadRoots: ["exports"], deniedPaths: [], signal: new AbortController().signal,
      authorizeRead: async (path) => { assert.equal(path, origin); readPermissions++; }, revalidateContext: async () => {},
      limits: { maxFileBytes: 1024, maxBatchBytes: 1024, maxFilesPerUpload: 1, transferTimeoutMs: 10000 },
    });
    assert.equal(readPermissions, 1);
    await writeFile(origin, "Modified original");
    assert.equal(await readFile(join(store.paths.staging, staged[0].stagedRef), "utf8"), "Synthetic staged bytes");
    const plan = {
      version: 1, id: "pack-proposal", sessionID: "pack-session", locationID: "a".repeat(64), account: "qa", site: "https://synthetic.invalid",
      credentialIdentity: "synthetic-person", issueId: "1", issueKey: "SYN-1", projectKey: "SYN", kind: "upload", audience: "ticket", files: staged,
      steps: [{ id: "step-1", kind: "mutation", fileRefs: [staged[0].stagedRef] }], expectedUpdated: created, policyFingerprint: "b".repeat(64),
      payload: {}, summary: "Synthetic pack check", createdAt: created, expiresAt: expires,
    };
    const saved = store.prepare(plan); store.close();
    const status = execFileSync(process.execPath, [join(copy, "dist/cli.js"), "status", "--global", "--proposal", plan.id], { env, cwd: directory, encoding: "utf8", timeout: 10000 });
    assert.equal(JSON.parse(status).state, "prepared");
    const functionalRecord = join(home, "functional-proposal.json");
    execFileSync(process.execPath, [functional, copy, "prepare", functionalRecord], { env, cwd: directory, stdio: "pipe", timeout: 20000 });
    for (const peer of uiPeers) assert(!existsSync(join(copy, "..", "..", peer, "package.json")));
    await install(source, io, { paths });
    assert.equal(await readFile(configPath, "utf8"), before);
    const upgradeSource = join(directory, "upgrade-source");
    await mkdir(upgradeSource);
    execFileSync("tar", ["-xzf", archive, "-C", upgradeSource], { timeout: 10000 });
    const nextPackage = join(upgradeSource, "package");
    const versionMatch = manifest.version.match(/^(\d+)\.(\d+)\.(\d+)/);
    const nextManifest = { ...manifest, version: `${versionMatch[1]}.${versionMatch[2]}.${Number(versionMatch[3]) + 1}` };
    await writeFile(join(nextPackage, "package.json"), JSON.stringify(nextManifest));
    const nextResult = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: nextPackage, env: npmEnv, encoding: "utf8", timeout: 20000 }));
    const nextPack = Array.isArray(nextResult) ? nextResult[0] : Object.values(nextResult)[0];
    await install(join(directory, nextPack.filename), io, { paths });
    const nextCopy = JSON.parse(await readFile(configPath, "utf8")).plugins[0].package;
    assert.notEqual(nextCopy, copy); assert(existsSync(join(copy, "dist/index.js")));
    assert.equal(await check(io, paths), 0);
    execFileSync(process.execPath, [functional, nextCopy, "apply", functionalRecord], { env, cwd: directory, stdio: "pipe", timeout: 20000 });
    const resolution = source === "local" ? ["--no"] : ["--yes", `--package=${archive}`];
    const output = execFileSync("npm", ["exec", "--offline", ...resolution, "--", "issuekeeper-jira", "check", "--global"], { env, cwd: directory, encoding: "utf8", timeout: 40000 });
    assert(output.includes("No comprueba conectividad"));
    await uninstall(io, paths);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).plugins, []);
    const reopened = new CopiedStore(paths.data);
    assert.deepEqual(reopened.get(plan.id), saved);
    assert.equal(await readFile(join(reopened.paths.staging, staged[0].stagedRef), "utf8"), "Synthetic staged bytes");
    reopened.close();
    execFileSync(process.execPath, [functional, nextCopy, "inspect", functionalRecord], { env, cwd: directory, stdio: "pipe", timeout: 20000 });
  }
  if (variant === "registry") {
    // Full journey from a simulated registry, outside the workspace: npm exec
    // runs the published CLI, whose install --global resolves "registry" and
    // verifies name, version and SHA-512 through ISSUEKEEPER_REGISTRY.
    // The scope routes to the simulated registry: npm exec resolves the whole
    // tree against a single registry, and the simulated one only serves this
    // package (a real private registry is configured per scope in .npmrc).
    const { startRegistryServer } = await import(new URL("../test/fixtures/registry-server.mjs", import.meta.url));
    const server = await startRegistryServer(archive);
    try {
      const home = join(directory, "registry home");
      const cwd = join(directory, "registry project");
      await mkdir(cwd);
      const env = { ...npmEnv, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), ISSUEKEEPER_REGISTRY: server.url };
      const execRegistry = (args, input = "") => new Promise((resolve, reject) => {
        const command = `npm exec --yes --legacy-peer-deps --@issuekeeper:registry=${server.url} --package=@issuekeeper/opencode-jira@${manifest.version} -- ${args}`;
        const child = spawn("script", ["-qfec", command, "/dev/null"], { env, cwd, timeout: 120000 });
        let output = "";
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.stderr.on("data", (chunk) => { output += chunk; });
        child.stdin.end(input);
        child.once("error", reject);
        child.once("close", (code, signal) => code === 0 ? resolve(output) : reject(new Error(`npm exec ${args} falló (${signal ?? code}):\n${output}`)));
      });
      const installOutput = await execRegistry("issuekeeper-jira install --global", "s\n");
      assert(installOutput.includes(`Origen: registro (${manifest.version})`), installOutput);
      assert(installOutput.includes("Paquete instalado"), installOutput);
      const paths = installerPaths(env);
      const configPath = join(paths.config, "opencode.jsonc");
      const readConfig = () => readFile(configPath, "utf8");
      const registryConfig = JSON.parse(await readConfig());
      assert.deepEqual(registryConfig.plugins[0].options.accounts, []);
      const copy = registryConfig.plugins[0].package;
      assert(registryConfig.instructions.filter((reference) => reference === paths.instructions).length === 1, await readConfig());
      assert.equal(await readFile(paths.instructions, "utf8"), await readFile(join(copy, "templates", "jira.md"), "utf8"));
      const copyManifest = JSON.parse(await readFile(join(copy, "package.json"), "utf8"));
      assert.equal(copyManifest.version, manifest.version);
      const toolsProbe = join(home, "registry-tools.mjs");
      const toolsRecord = join(home, "registry-tools.json");
      await writeFile(toolsProbe, [
        `import { writeFile } from "node:fs/promises";`,
        `import { join } from "node:path";`,
        `import { pathToFileURL } from "node:url";`,
        `const [installed, record] = process.argv.slice(2);`,
        `const { default: plugin } = await import(pathToFileURL(join(installed, "dist/index.js")).href);`,
        `const tools = [];`,
        `const cleanup = await plugin.setup({`,
        `  location: { directory: process.cwd() },`,
        `  options: { accounts: [] },`,
        `  tool: { transform: async (callback) => callback({ namespace() {}, add(tool) { tools.push(tool); } }) },`,
        `  permission: { assert: async () => { throw new Error("No execution expected during plugin setup"); } },`,
        `});`,
        `await cleanup?.();`,
        `await writeFile(record, JSON.stringify(tools.map((tool) => tool.name).sort()));`,
      ].join("\n"));
      execFileSync(process.execPath, [toolsProbe, copy, toolsRecord], { env, cwd, timeout: 30000 });
      assert.deepEqual(JSON.parse(await readFile(toolsRecord, "utf8")), [
        "accounts_list", "attachment_download", "attachment_upload_prepare", "attachments_list", "change_apply", "comment_prepare", "comments_list", "connection_test", "issue_edit_metadata", "issue_get", "issue_update_prepare", "issues_search", "mention_candidates", "transition_prepare", "transitions_list",
      ]);
      const checkOutput = execFileSync(process.execPath, [join(copy, "dist/cli.js"), "check", "--global"], { env, cwd, encoding: "utf8", timeout: 30000 });
      assert(checkOutput.includes("No comprueba conectividad"), checkOutput);
      const { ChangeStore: CopiedStore } = await import(pathToFileURL(join(copy, "dist/state/store.js")).href);
      const stamp = new Date();
      const created = stamp.toISOString();
      const expires = new Date(stamp.getTime() + 600000).toISOString();
      const store = new CopiedStore(paths.data, { now: () => stamp });
      const plan = {
        version: 1, id: "registry-proposal", sessionID: "registry-session", locationID: "c".repeat(64), account: "qa", site: "https://synthetic.invalid",
        credentialIdentity: "synthetic-person", issueId: "1", issueKey: "SYN-1", projectKey: "SYN", kind: "fields",
        steps: [{ id: "step-1", kind: "mutation", fileRefs: [] }], files: [], expectedUpdated: created, policyFingerprint: "d".repeat(64),
        payload: {}, summary: "Registry smoke proposal", createdAt: created, expiresAt: expires,
      };
      const saved = store.prepare(plan); store.close();
      const before = await readConfig();
      const reinstallOutput = await execRegistry("issuekeeper-jira install --global");
      assert(reinstallOutput.includes("Instalación sin diferencias."), reinstallOutput);
      assert.equal(await readConfig(), before);
      const uninstallOutput = await execRegistry("issuekeeper-jira uninstall --global", "s\n");
      assert(uninstallOutput.includes("Referencias administradas retiradas"), uninstallOutput);
      assert.deepEqual(JSON.parse(await readConfig()).plugins, []);
      assert(!existsSync(paths.instructions));
      const reopened = new CopiedStore(paths.data);
      assert.deepEqual(reopened.get(plan.id), saved);
      reopened.close();
    } finally { await server.close(); }
  }
  console.log(`Smoke ${variant}: instalación, npm exec, check, reinstalación y retirada correctos.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
