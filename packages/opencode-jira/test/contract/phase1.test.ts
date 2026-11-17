import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { toolHarness } from "../harness.js";
import { config, configEmpty, createService, issue, json, mockFetch, request, signal, configTwoSites } from "../helpers.js";
import { JiraCloud } from "../../src/jira/cloud.js";
import { HttpClient } from "../../src/http.js";
import { Service } from "../../src/core/service.js";

let directory: string;
beforeEach(async () => { directory = await mkdtemp("/tmp/opencode/ik-phase1-"); vi.stubEnv("IK_TEST_WORK", "private-secret"); vi.stubEnv("IK_TEST_CLIENT", "client-secret"); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const calls: [string, Record<string, unknown>][] = [
  ["accounts_list", {}], ["connection_test", { account: "work" }],
  ["issue_get", { account: "work", issueKey: "IK-1" }],
  ["issues_search", { account: "work", jql: "project = IK" }],
  ["comments_list", { account: "work", issueKey: "IK-1" }],
  ["mention_candidates", { account: "work", issueKey: "IK-1", query: "Ana", audience: "ticket" }],
  ["attachments_list", { account: "work", issueKey: "IK-1" }],
  ["attachment_download", { account: "work", issueKey: "IK-1", attachmentId: "101" }],
];
describe("[6.7][E00][CF-01] common read contract", () => {
  it.each(calls.filter(([name]) => ["issues_search", "comments_list", "mention_candidates", "attachments_list"].includes(name)))("publishes and enforces the configured page limit for %s", async (name, args) => {
    const c = config(); c.output.pageSize = 2; c.output.maxPageSize = 5;
    const fetcher = mockFetch(() => { throw new Error("network prohibited"); });
    const service = await createService(c, directory, fetcher);
    try {
      const h = await toolHarness(service);
      expect(h.tools.get(name)!.input).toMatchObject({ properties: { maxResults: { minimum: 1, maximum: 5, description: expect.stringContaining("máximo 5") } } });
      expect(h.tools.get(name)!.description).toContain("omitir maxResults");
      expect(h.tools.get(name)!.description).toContain("predeterminado 2, máximo 5");
      expect(await h.invoke(name, { ...args, maxResults: 6 })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
      expect(h.assert).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    } finally { service.close(); }
  });
  it("preserves candidate identity refinements in the configured page schema", async () => {
    const service = await createService(config(), directory);
    try {
      const h = await toolHarness(service);
      const result = await h.invoke("mention_candidates", { account: "work", issueKey: "IK-1", audience: "ticket", query: "Ana", accountId: "person" });
      expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
      expect(h.assert).not.toHaveBeenCalled();
    } finally { service.close(); }
  });
  it("keeps explicit stop rules in every tool description without replacing native denials", async () => {
    const service = await createService(configEmpty(), directory);
    try {
      const h = await toolHarness(service);
      expect(h.tools.size).toBe(8);
      for (const tool of h.tools.values()) {
        expect(tool.description).toContain("Permission denied");
        expect(tool.description).toContain("sin más llamadas");
        expect(tool.description).toContain("tampoco accounts_list ni connection_test");
      }
      expect(h.tools.get("issues_search")!.description).toContain("assignee = currentUser()");
      expect(h.tools.get("issues_search")!.description).toContain("statusCategory != Done");
      expect(h.tools.get("mention_candidates")!.description).toContain("public para pública JSM");
      const denial = new Error("Permission denied: jira.accounts");
      h.assert.mockRejectedValue(denial);
      await expect(h.invoke("accounts_list", {})).rejects.toBe(denial);
    } finally { service.close(); }
  });
  it.each(["../outside", "/etc", ".git", ".ssh", "secrets"])("[CFG-06] rejects unsafe upload root %s", async (root) => {
    const c = config(); c.attachments.uploadRoots = [root];
    const fetcher = mockFetch(() => json(issue()));
    await expect(createService(c, directory, fetcher)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("loads the empty base and never asks remote permission without an account", async () => {
    const fetcher = mockFetch(() => { throw new Error("network prohibited"); });
    const service = await createService(configEmpty(), directory, fetcher);
    try {
      const h = await toolHarness(service);
      const accounts = await h.invoke("accounts_list", {});
      expect(accounts).toMatchObject({ ok: true, data: [] });
      expect(accounts.warnings.join()).toContain("account.example.jsonc");
      h.assert.mockClear();
      for (const [name, args] of calls.slice(1)) {
        expect(await h.invoke(name, args)).toMatchObject({ ok: false, error: { code: "ACCOUNT_UNAVAILABLE" }, warnings: [] });
      }
      expect(fetcher).not.toHaveBeenCalled(); expect(h.assert).not.toHaveBeenCalled();
    } finally { service.close(); }
  });
  it.each(calls)("[REG-02] validates session scope for %s before permissions or HTTP", async (name, args) => {
    const fetcher = mockFetch(() => json(issue()));
    const service = await createService(config(), directory, fetcher);
    try {
      const h = await toolHarness(service);
      h.session.mockRejectedValue(new Error("session not found"));
      expect(await h.invoke(name, args)).toMatchObject({ ok: false, error: { code: "FILE_ACCESS_DENIED" } });
      expect(h.assert).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
      h.session.mockResolvedValue({ location: { directory: "/tmp/opencode" } });
      expect(await h.invoke(name, args)).toMatchObject({ ok: false, error: { code: "FILE_ACCESS_DENIED" } });
    } finally { service.close(); }
  });
  it.each(calls)("[PE-06] propagates the original permission rejection for %s", async (name, args) => {
    const fetcher = mockFetch(() => json(issue()));
    const service = await createService(config(), directory, fetcher);
    try {
      const h = await toolHarness(service); const denial = new Error("native deny");
      h.assert.mockRejectedValue(denial);
      await expect(h.invoke(name, args)).rejects.toBe(denial);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { service.close(); }
  });
  it("[RES-01] preserves a valid alias and safe structural field errors", async () => {
    const service = await createService(config(), directory);
    try {
      const h = await toolHarness(service);
      expect(await h.invoke("issue_get", { account: "work", issueKey: "bad", "PRIVATE_SECRET": "do-not-echo" })).toMatchObject({
        ok: false, account: "work", error: { fieldErrors: { issueKey: expect.any(String), input: expect.any(String) } }, warnings: [],
      });
      const result = await h.invoke("issue_get", { account: "INVALID_SECRET", issueKey: "bad" });
      expect(result.account).toBeUndefined(); expect(JSON.stringify(result)).not.toContain("INVALID_SECRET");
      expect(h.assert).not.toHaveBeenCalled();
    } finally { service.close(); }
  });
  it("[HTTP-05] propagates cancellation before any permission or HTTP", async () => {
    const fetcher = mockFetch(() => json(issue())); const service = await createService(config(), directory, fetcher);
    try {
      const h = await toolHarness(service); const controller = new AbortController(); const reason = new Error("native abort"); controller.abort(reason);
      for (const [name, input] of calls) await expect(h.invoke(name, input, controller.signal)).rejects.toBe(reason);
      expect(fetcher).not.toHaveBeenCalled(); expect(h.assert).not.toHaveBeenCalled();
    } finally { service.close(); }
  });
  it("[REG-04][OP-02] unloading aborts an in-flight read natively", async () => {
    let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    const fetcher = mockFetch((_, init) => new Promise<Response>((_, reject) => {
      started(); init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    const service = await createService(config(), directory, fetcher);
    const h = await toolHarness(service);
    const pending = h.invoke("issue_get", { account: "work", issueKey: "IK-1" });
    await ready; service.close();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("[REG-04][PE-06] rejects a canonical key even after permitting the requested key", async () => {
    const fetcher = mockFetch(() => json(issue("IK-2")));
    const service = await createService(config(), directory, fetcher);
    try {
      const h = await toolHarness(service); const denial = new Error("canonical deny");
      h.assert.mockImplementation(async (permission) => {
        if ((permission as any).resources.some((resource: string) => resource.includes("/IK-2"))) throw denial;
      });
      await expect(h.invoke("mention_candidates", { account: "work", issueKey: "IK-1", query: "Ana", audience: "ticket" })).rejects.toBe(denial);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { service.close(); }
  });
  it("[CTA-05][E04][AC-06] isolates credential failure and default status", async () => {
    const service = await createService(config(), directory, mockFetch(() => json({}, 401)));
    try {
      const h = await toolHarness(service);
      expect((await h.invoke("issue_get", { account: "work", issueKey: "IK-1" })).error.code).toBe("AUTH_FAILED");
      const accounts = await h.invoke("accounts_list", {});
      expect(accounts.data.map((a: any) => a.state)).toEqual(["unavailable", "unchecked"]);
      expect(accounts.data.map((a: any) => a.default)).toEqual([false, false]);
    } finally { service.close(); }
  });
  it("[RES-05][E03][OP-03] correlates a retry without leaking secrets or body", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    let count = 0;
    const fetcher = mockFetch(() => ++count === 1 ? json({ secret: "remote-private-body" }, 503) : json(issue()));
    const service = await createService(config(), directory, fetcher);
    try {
      const h = await toolHarness(service);
      const result = await h.invoke("issue_get", { account: "work", issueKey: "IK-1" });
      expect(result.ok).toBe(true);
      expect(logger).toHaveBeenCalledTimes(1);
      const event = JSON.parse(String(logger.mock.calls[0]![0]));
      expect(event).toMatchObject({ requestId: result.meta.requestId, tool: "jira_issue_get", account: "work", status: 200, attempts: 2, code: "OK" });
      for (const secret of ["private-secret", "Authorization", "remote-private-body", "email"]) expect(JSON.stringify(event)).not.toContain(secret);
    } finally { service.close(); }
  });
  it("[ARQ-03][E04][LE-03] enforces real-project policy for a simulated provider", async () => {
    const c = config(); const provider = new JiraCloud(c, new HttpClient(c));
    vi.spyOn(provider, "get").mockResolvedValue({ data: { ...issue(), provider: "jira-cloud", account: "work", source: "platform", summary: "hidden", project: { id: "1", key: "OTHER" }, status: { id: "1", name: "Open" }, updated: "now", fetchedAt: "now", url: "https://example.atlassian.net" }, warnings: [] });
    const service = await Service.create(c, directory, provider);
    try {
      const h = await toolHarness(service);
      const result = await h.invoke("comments_list", { account: "work", issueKey: "IK-1" });
      expect(result.error.code).toBe("FORBIDDEN"); expect(JSON.stringify(result)).not.toContain("hidden");
    } finally { service.close(); }
  });
});

describe("[5.6][E03][ME-01] contextual mention candidates", () => {
  it("retains homonyms, omits inactive users and strips email/avatar fields", async () => {
    const c = config();
    const fetcher = mockFetch((url) => {
      if (url.pathname.endsWith("viewissue/search")) {
        expect(url.searchParams.get("issueKey")).toBe("IK-1"); expect(url.searchParams.get("query")).toBe("Ana");
        expect(url.searchParams.get("startAt")).toBe("0"); expect(url.searchParams.get("maxResults")).toBe("25");
        return json([{ accountId: "a", displayName: "Ana", emailAddress: "private@example.com", avatarUrls: {} },
          { accountId: "b", displayName: "Ana" }, { accountId: "inactive", displayName: "Ana", active: false }]);
      }
      return json(issue());
    });
    const provider = new JiraCloud(c, new HttpClient(c, fetcher));
    try {
      const result = await provider.mentionCandidates(c.accounts[0]!, { account: "work", issueKey: "IK-1", query: "Ana", audience: "ticket" }, signal());
      expect(result.data.ambiguous).toBe(true);
      expect(result.data.values.map((v) => v.accountId)).toEqual(["a", "b"]);
      expect(JSON.stringify(result)).not.toContain("private@example.com"); expect(JSON.stringify(result)).not.toContain("avatarUrls");
      expect(result.data.values.every((v) => v.validation === "validated")).toBe(true);
      expect(result.warnings?.join(" ")).toContain("no prepara propuestas ni publica comentarios");
    } finally { provider.close(); }
  });
  it("[ME-02] validates restricted projects before consulting users", async () => {
    const c = config(); const fetcher = mockFetch(() => json(issue("IK-1", "OTHER")));
    const provider = new JiraCloud(c, new HttpClient(c, fetcher));
    try {
      await expect(provider.mentionCandidates(c.accounts[0]!, { account: "work", issueKey: "IK-1", query: "Ana", audience: "ticket" }, signal())).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { provider.close(); }
  });
  it("[ME-05] binds cursors to account, ticket, query and audience", async () => {
    const c = config();
    const fetcher = mockFetch((url) => url.pathname.endsWith("viewissue/search") ? json([{ accountId: "a", displayName: "Ana" }]) : json(issue()));
    const provider = new JiraCloud(c, new HttpClient(c, fetcher));
    const input = { account: "work", issueKey: "IK-1", query: "Ana", audience: "ticket" as const, maxResults: 1 };
    try {
      const first = await provider.mentionCandidates(c.accounts[0]!, input, signal());
      expect(first.data.cursor).toBeDefined();
      for (const changes of [{ query: "Other" }, { audience: "public" as const }, { visibility: { type: "role" as const, value: "Team" } }, { maxResults: 2 }]) {
        if ("audience" in changes) continue;
        await expect(provider.mentionCandidates(c.accounts[0]!, { ...input, ...changes, cursor: first.data.cursor }, signal())).rejects.toMatchObject({ code: "CURSOR_INVALID" });
      }
      await expect(provider.mentionCandidates(c.accounts[1]!, { ...input, account: "client", cursor: first.data.cursor }, signal())).rejects.toMatchObject({ code: "CURSOR_INVALID" });
    } finally { provider.close(); }
  });
  it("[ME-03] paginates reporter and participants by JSM audience using only GET", async () => {
    const c = config(true);
    const fetcher = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      if (url.pathname.endsWith("viewissue/search")) return json([]);
      if (url.pathname.endsWith("/participant")) {
        expect(url.searchParams.get("start")).toBe("0"); expect(url.searchParams.get("limit")).toBe("25");
        return json({ start: 0, limit: 25, size: 1, isLastPage: true, values: [{ accountId: "participant", displayName: "Customer Two", emailAddress: "hidden" }] });
      }
      return url.pathname.includes("/api/3/issue/") ? json(issue()) : json(request());
    });
    const provider = new JiraCloud(c, new HttpClient(c, fetcher));
    try {
      const input = { account: "work", issueKey: "IK-1", query: "Customer", audience: "public" as const };
      const first = await provider.mentionCandidates(c.accounts[0]!, input, signal());
      expect(first.data.values[0]?.origins).toEqual(["reporter"]);
      expect(first.data.isLast).toBe(false);
      expect(first.warnings.join(" ")).toContain("no ha identificado una persona única");
      expect(first.warnings.join(" ")).toContain("no elija por origen o validación");
      const second = await provider.mentionCandidates(c.accounts[0]!, { ...input, cursor: first.data.cursor }, signal());
      const third = await provider.mentionCandidates(c.accounts[0]!, { ...input, cursor: second.data.cursor }, signal());
      expect(third.data.values[0]).toMatchObject({ accountId: "participant", origins: ["participant"], validation: "validated" });
      expect(third.data.isLast).toBe(true);
      expect(JSON.stringify(third)).not.toContain("hidden");
    } finally { provider.close(); }
  });
  it("[ME-04] never claims validation of role/group visibility", async () => {
    const c = config();
    const provider = new JiraCloud(c, new HttpClient(c, mockFetch((url) => url.pathname.endsWith("viewissue/search") ? json([{ accountId: "a", displayName: "Ana" }]) : json(issue()))));
    try {
      const result = await provider.mentionCandidates(c.accounts[0]!, { account: "work", issueKey: "IK-1", query: "Ana", audience: "ticket", visibility: { type: "role", value: "Secret" } }, signal());
      expect(result.data.values[0]?.validation).toBe("unverified");
    } finally { provider.close(); }
  });
  it("[ME-05] rejects a cursor from another canonical ticket, audience or site", async () => {
    const c = config(true);
    const fetcher = mockFetch((url) => {
      if (url.pathname.endsWith("viewissue/search")) return json([{ accountId: "a", displayName: "Ana" }]);
      const key = /(?:issue|request)\/([A-Z]+-[0-9]+)/.exec(url.pathname)?.[1] ?? "IK-1";
      return url.pathname.includes("/api/3/issue/") ? json(issue(key)) : json({ ...request(), issueKey: key });
    });
    const provider = new JiraCloud(c, new HttpClient(c, fetcher));
    try {
      const input = { account: "work", issueKey: "IK-1", query: "Ana", audience: "internal" as const, maxResults: 1 };
      const first = await provider.mentionCandidates(c.accounts[0]!, input, signal());
      for (const changes of [{ issueKey: "IK-2" }, { audience: "public" as const }]) {
        await expect(provider.mentionCandidates(c.accounts[0]!, { ...input, ...changes, cursor: first.data.cursor }, signal())).rejects.toMatchObject({ code: "CURSOR_INVALID" });
      }
      const otherSite = { ...c.accounts[0]!, siteUrl: "https://another.atlassian.net" };
      await expect(provider.mentionCandidates(otherSite, { ...input, cursor: first.data.cursor }, signal())).rejects.toMatchObject({ code: "CURSOR_INVALID" });
    } finally { provider.close(); }
  });
});

describe("[4.2][E01][AC-03] scoped connection", () => {
  it.each([true, false])("compares the anonymous tenant before the authenticated gateway (%s)", async (matches) => {
    const c = configTwoSites(); const a = c.accounts[1]!;
    const fetcher = mockFetch((url, init) => {
      if (url.pathname === "/_edge/tenant_info") {
        expect(url.origin).toBe(a.siteUrl); expect(init.headers).not.toHaveProperty("Authorization");
        expect(init.redirect).toBe("manual");
        return json({ cloudId: matches && a.auth.mode === "cloud-scoped-token" ? a.auth.cloudId : "different" });
      }
      expect(url.origin).toBe("https://api.atlassian.com"); return json({ accountId: "client", emailAddress: "hidden" });
    });
    const service = await createService(c, directory, fetcher);
    try {
      const h = await toolHarness(service); const result = await h.invoke("connection_test", { account: "client" });
      expect(result.ok).toBe(matches);
      expect(fetcher).toHaveBeenCalledTimes(matches ? 2 : 1);
    } finally { service.close(); }
  });
  it("[LEC-05] reads software comments with a JSM-enabled account", async () => {
    const c = config(true);
    const fetcher = mockFetch((url) => {
      if (url.pathname.endsWith("/comment")) return json({ startAt: 0, maxResults: 25, total: 1, comments: [{ id: "1", body: issue().fields.description }] });
      return json({ ...issue(), fields: { ...issue().fields, project: { ...issue().fields.project, projectTypeKey: "software" } } });
    });
    const provider = new JiraCloud(c, new HttpClient(c, fetcher));
    try {
      expect((await provider.comments(c.accounts[0]!, { account: "work", issueKey: "IK-1" }, signal())).data.values[0]?.audience).toBe("ticket");
      expect(fetcher.mock.calls.some(([url]) => String(url).includes("servicedeskapi"))).toBe(false);
    } finally { provider.close(); }
  });
});
