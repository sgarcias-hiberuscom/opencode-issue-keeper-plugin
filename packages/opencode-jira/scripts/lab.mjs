import { mkdtemp, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "../dist/config.js";
import { Service } from "../dist/core/service.js";
import { JiraCloud } from "../dist/jira/cloud.js";
import { HttpClient } from "../dist/http.js";
import { registerReads } from "../dist/tools/reads.js";

const code = process.argv[2];
const variant = process.argv[3] ?? "default";
const cases = {
  "HT-01": ["default"], "HT-02": ["default", "400", "401", "403", "404", "413", "422"],
  "HT-03": ["default", "cancel"], "HT-04": ["default", "redirect", "large"],
  "HT-05": ["default", "restricted"], "HT-06": ["default", "redirect"],
  "HT-07": ["default"], "HT-08": ["default"],
};
if (process.argv.length > 4 || !cases[code]?.includes(variant)) {
  throw new Error("Uso: node scripts/lab.mjs HT-01..HT-08 [variante]; consulte README.");
}
const root = await mkdtemp("/tmp/opencode/issuekeeper-lab-");
process.env.ISSUEKEEPER_LAB_DUMMY = "laboratory-only-not-a-real-credential";
const config = parseConfig({
  accounts: [
    { id: "direct", siteUrl: "https://laboratory.atlassian.net", auth: { mode: "cloud-token", email: "lab@example.invalid", tokenEnv: "ISSUEKEEPER_LAB_DUMMY" }, restrictedProjects: ["OUT"] },
    { id: "scoped", siteUrl: "https://other-laboratory.atlassian.net", auth: { mode: "cloud-scoped-token", cloudId: "11111111-2222-4333-8444-555555555555", email: "lab@example.invalid", tokenEnv: "ISSUEKEEPER_LAB_DUMMY" }, restrictedProjects: ["OUT"] },
  ],
  http: { maxResponseBytes: 1024 },
});
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const ticket = (project = "LAB") => ({ id: "1", key: "LAB-1", fields: { project: { id: "1", key: project, projectTypeKey: "software" }, updated: "2026-01-01T00:00:00Z", summary: "Laboratory", status: { id: "1", name: "Open" } } });
const attachment = { id: "101", filename: "lab.txt", size: 5, mimeType: "text/plain" };
const controller = new AbortController();
let attempts = 0;
const fetcher = async (input, init) => {
  const url = new URL(input);
  attempts++;
  console.log(JSON.stringify({ event: "request", method: init.method, host: url.hostname, gateway: url.pathname.startsWith("/ex/jira/"), authorizationPresent: Boolean(init.headers?.Authorization) }));
  if (url.pathname === "/_edge/tenant_info") return json({ cloudId: config.accounts[1].auth.cloudId });
  if (code === "HT-02") return json({ ignored: "remote body must not appear in result" }, Number(variant === "default" ? 403 : variant));
  if (code === "HT-03" && attempts === 1) {
    if (variant === "cancel") controller.abort(new DOMException("Laboratory cancellation", "AbortError"));
    return json({}, 503);
  }
  if (code === "HT-04") {
    if (variant === "redirect") return new Response(null, { status: 303, headers: { location: "https://invalid.example/signed-do-not-display" } });
    if (variant === "large") return json({ value: "x".repeat(2048) });
    return new Response("{invalid", { headers: { "content-type": "application/json" } });
  }
  if (url.pathname.endsWith("/search/jql")) return json({ issues: [ticket(variant === "restricted" ? "OUT" : "LAB")], nextPageToken: "repeated", isLast: false });
  if (url.pathname.includes("/attachment/content/")) {
    if (variant === "redirect") return new Response(null, { status: 303, headers: { location: "https://invalid.example/signed-do-not-display" } });
    return new Response(code === "HT-08" ? "hello" : "hel");
  }
  if (url.pathname.endsWith("/attachment/101")) return json(attachment);
  if (url.searchParams.get("fields") === "attachment,project") return json({ id: "1", fields: { project: ticket().fields.project, attachment: [attachment] } });
  return url.pathname.endsWith("/myself") ? json({ accountId: "laboratory" }) : json(ticket());
};
const service = await Service.create(config, root, new JiraCloud(config, new HttpClient(config, fetcher)));
try {
  const tools = new Map();
  await registerReads({
    location: { directory: root }, session: { get: async () => ({ location: { directory: root } }) },
    tool: { transform: async (callback) => callback({ namespace() {}, add(tool) { tools.set(tool.name, tool); } }) },
    permission: { assert: async ({ action }) => { if (code === "HT-07" && action === "edit") throw new Error("Native laboratory edit denial"); } },
  }, service);
  const execution = { sessionID: "laboratory", agent: "build", messageID: "lab", id: "lab", signal: controller.signal };
  async function invoke(name, input) {
    try {
      const result = await tools.get(name).execute(input, execution);
      console.log(result.content);
      return JSON.parse(result.content);
    } catch { console.log(JSON.stringify({ nativeFailure: true })); }
  }
  if (code === "HT-01") {
    for (const account of ["direct", "scoped"]) await invoke("connection_test", { account });
  } else if (code === "HT-05") {
    const input = { account: "direct", jql: "project = LAB" };
    const first = await invoke("issues_search", input);
    await invoke("issues_search", { ...input, cursor: first.data.cursor });
  } else if (["HT-06", "HT-07", "HT-08"].includes(code)) {
    if (code === "HT-08") {
      await mkdir(join(root, ".issuekeeper/downloads"), { recursive: true, mode: 0o700 });
      await writeFile(join(root, ".issuekeeper/downloads/101-lab.txt"), "preserved");
    }
    await invoke("attachment_download", { account: "direct", issueKey: "LAB-1", attachmentId: "101" });
    console.log(JSON.stringify({ files: await readdir(join(root, ".issuekeeper/downloads")).catch(() => []) }));
  } else await invoke("issue_get", { account: "direct", issueKey: "LAB-1" });
  console.log(JSON.stringify({ laboratoryOnly: true, requests: attempts, realJiraContacted: false }));
} finally { service.close(); await rm(root, { recursive: true, force: true }); }
