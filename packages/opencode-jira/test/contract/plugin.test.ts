import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import type { Plugin } from "@opencode/plugin";
import plugin from "../../src/index.js";
import { Service } from "../../src/core/service.js";
import { registerReads } from "../../src/tools/reads.js";
import { attachment, config, issue, json, mockFetch } from "../helpers.js";

type Context = Parameters<Plugin.Plugin["setup"]>[0];
type Editor = Parameters<Parameters<Context["tool"]["transform"]>[0]>[0];
type Tool = Parameters<Editor["add"]>[0];
type Execution = Parameters<Tool["execute"]>[1];
let location: string;
const execution = { sessionID: "session-1", agent: "build", messageID: "message-1", id: "tool-1", signal: new AbortController().signal, progress: async () => {} } as unknown as Execution;

beforeEach(async () => { vi.stubEnv("IK_TEST_WORK", "secret-for-tests"); location = await mkdtemp("/tmp/opencode/ik-plugin-"); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(location, { recursive: true }); });

function harness() {
  const tools = new Map<string, Tool>();
  const assert = vi.fn(async (_: unknown) => {});
  const getSession = vi.fn(async () => ({ location: { directory: location } }));
  const context = {
    location: { directory: location }, options: { accounts: [config().accounts[0]] },
    permission: { assert }, session: { get: getSession },
    tool: { transform: async (callback: (editor: Editor) => void) => { callback({ list: () => [], get: () => undefined, update() {}, remove() {}, namespace() {}, add(tool: Tool) { tools.set(tool.name, tool); } }); } },
  } as unknown as Context;
  async function invoke(name: string, args: unknown) {
    const result = await tools.get(name)!.execute(args, execution);
    return JSON.parse(String(result.content));
  }
  return { tools, context, assert, invoke, getSession };
}

describe("native OpenCode V2 contract", () => {
  it("loads the pinned SDK and registers only seven read/download tools without network calls", async () => {
    const h = harness();
    const cleanup = await plugin.setup(h.context);
    expect(plugin.id).toBe("issuekeeper.jira");
    expect([...h.tools.keys()].sort()).toEqual(["accounts_list", "attachment_download", "attachments_list", "comments_list", "connection_test", "issue_get", "issues_search"]);
    for (const tool of h.tools.values()) expect(tool.options?.namespace).toBe("jira");
    expect(h.assert).not.toHaveBeenCalled();
    await cleanup?.();
  });
  it("registers even when one secret is missing and hides all token sources", async () => {
    const h = harness(); const service = await Service.create(config(), location, mockFetch(() => { throw new Error("must not connect"); }));
    try {
      await registerReads(h.context, service);
      const result = await h.invoke("accounts_list", {});
      expect(result.ok).toBe(true); expect(result.data[1].state).toBe("unavailable");
      expect(JSON.stringify(result)).not.toContain("secret-for-tests"); expect(JSON.stringify(result)).not.toContain("tokenEnv");
      expect(h.assert.mock.calls[0]?.[0]).toMatchObject({ action: "jira.accounts" });
    } finally { service.close(); }
  });
  it("propagates permission rejection, without issuing an HTTP call", async () => {
    const h = harness(); const denial = new Error("native OpenCode rejection"); h.assert.mockRejectedValue(denial);
    const fetcher = mockFetch(() => json(issue())); const service = await Service.create(config(), location, fetcher);
    try {
      await registerReads(h.context, service);
      await expect(h.invoke("issue_get", { account: "work", issueKey: "IK-1" })).rejects.toBe(denial);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { service.close(); }
  });
  it("returns safe operational errors and valid explicitly truncated JSON", async () => {
    const h = harness(); const c = config(); c.output.maxTextChars = 10;
    const service = await Service.create(c, location, mockFetch(() => json({ ...issue(), fields: { ...issue().fields, summary: "x".repeat(100) } })));
    try {
      await registerReads(h.context, service);
      const result = await h.invoke("issue_get", { account: "work", issueKey: "IK-1" });
      expect(result.ok).toBe(true); expect(result.account).toBe("work"); expect(result.meta).toMatchObject({ truncated: true, untrustedContent: true });
      expect(h.assert).toHaveBeenCalledTimes(1);
      expect(result.data.summary).toContain("truncado");
      const unknown = await h.invoke("issue_get", { account: "missing", issueKey: "IK-1" });
      expect(unknown).toMatchObject({ ok: false, account: "missing", error: { code: "ACCOUNT_UNAVAILABLE" } });
      const invalid = await h.invoke("issue_get", { account: "work", issueKey: "IK-1", token: "secret-input" });
      expect(invalid.error.code).toBe("VALIDATION_FAILED"); expect(JSON.stringify(invalid)).not.toContain("secret-input");
    } finally { service.close(); }
  });
  it("requires jira.download and edit before any binary transfer", async () => {
    const h = harness(); const denial = new Error("local edit rejected");
    h.assert.mockImplementation(async (input) => { if ((input as { action: string }).action === "edit") throw denial; });
    const fetcher = mockFetch((url) => url.searchParams.get("fields") === "attachment,project"
      ? json({ id: "10001", fields: { project: issue().fields.project, attachment: [attachment] } }) : json(issue()));
    const service = await Service.create(config(), location, fetcher);
    try {
      await registerReads(h.context, service);
      await expect(h.invoke("attachment_download", { account: "work", issueKey: "IK-1", attachmentId: "101" })).rejects.toBe(denial);
      const actions = h.assert.mock.calls.map(([input]) => (input as { action: string }).action);
      expect(actions).toContain("jira.read"); expect(actions).toContain("jira.download"); expect(actions).toContain("edit");
      expect(fetcher.mock.calls.some(([url]) => String(url).includes("attachment/content"))).toBe(false);
      expect(await readdir(location)).toEqual([]);
    } finally { service.close(); }
  });
});
