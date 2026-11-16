import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { configTwoSites, createService, issue, request, attachment, json, mockFetch } from "../helpers.js";
import { toolHarness } from "../harness.js";

let root: string;
beforeEach(async () => { root = await mkdtemp("/tmp/opencode/ik-two-sites-"); vi.stubEnv("IK_TEST_WORK", "work-secret"); vi.stubEnv("IK_TEST_CLIENT", "client-secret"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe("[10.3][E01][E02][E03][E04][E13][AC-02] two isolated sites", () => {
  it.each([false, true])("preserves identity, web origin and scoped prefixes on every route (JSM=%s)", async (jsm) => {
    const c = configTwoSites();
    c.accounts.forEach((account) => { account.serviceManagement.enabled = jsm; });
    const used = new Set<string>();
    const fetcher = mockFetch((url, init) => {
      const scoped = url.hostname === "api.atlassian.com" || url.hostname === "client.atlassian.net";
      const account = c.accounts[scoped ? 1 : 0]!;
      const prefix = "/ex/jira/11111111-2222-4333-8444-555555555555/";
      if (url.pathname === "/_edge/tenant_info") {
        expect(init.headers).not.toHaveProperty("Authorization");
        return json({ cloudId: "11111111-2222-4333-8444-555555555555" });
      }
      expect(url.origin).toBe(scoped ? "https://api.atlassian.com" : account.siteUrl);
      if (scoped) expect(url.pathname.startsWith(prefix)).toBe(true);
      const path = url.pathname.replace(scoped ? prefix : "/", "");
      used.add(`${account.id}:${path.split("?")[0]}`);
      const authorization = (init.headers as Record<string, string>).Authorization!;
      expect(Buffer.from(authorization.slice(6), "base64").toString()).toBe(`${account.auth.email}:${scoped ? "client" : "work"}-secret`);
      const raw = issue();
      raw.fields.project.projectTypeKey = jsm ? "service_desk" : "software";
      if (path === "rest/api/3/myself") return json({ accountId: account.id });
      if (path === "rest/servicedeskapi/servicedesk") return json({ start: 0, limit: 1, size: 0, isLastPage: true, values: [] });
      if (path === "rest/api/3/search/jql") { expect(init.method).toBe("POST"); return json({ issues: [raw], isLast: true }); }
      expect(init.method).toBe("GET");
      if (path.endsWith("user/viewissue/search")) return json([{ accountId: "person", displayName: "Ana" }]);
      if (path.endsWith("/participant")) return json({ start: 0, limit: 25, size: 0, isLastPage: true, values: [] });
      if (path.endsWith("/comment")) return path.startsWith("rest/servicedeskapi/")
        ? json({ start: 0, limit: 25, size: 1, isLastPage: true, values: [{ id: "1", body: "Visible JSM", public: true }] })
        : json({ startAt: 0, maxResults: 25, total: 1, comments: [{ id: "1", body: raw.fields.description }] });
      if (path === "rest/api/3/attachment/101") return json(attachment);
      if (path.includes("attachment/content/") || path.endsWith("attachment/101")) return new Response("hello");
      if (path.endsWith("/attachment")) return json({ start: 0, limit: Number(url.searchParams.get("limit")), size: 1, isLastPage: true, values: [{ ...attachment, id: undefined, _links: { jiraRest: `${account.siteUrl}/rest/api/2/attachment/101` } }] });
      if (path.startsWith("rest/servicedeskapi/request/")) return json(request());
      if (url.searchParams.get("fields") === "attachment,project") return json({ id: raw.id, fields: { project: raw.fields.project, attachment: [attachment] } });
      return json(raw);
    });
    const service = await createService(c, root, fetcher);
    try {
      const h = await toolHarness(service);
      for (const account of c.accounts) {
        const ref = { account: account.id, issueKey: "IK-1" };
        expect((await h.invoke("connection_test", { account: account.id })).ok).toBe(true);
        const ticket = await h.invoke("issue_get", ref);
        expect(ticket.data.url).toBe(`${account.siteUrl}/browse/IK-1`);
        expect((await h.invoke("issues_search", { account: account.id, jql: "project = IK" })).ok).toBe(true);
        expect((await h.invoke("comments_list", ref)).ok).toBe(true);
        expect((await h.invoke("mention_candidates", { ...ref, query: "Ana", audience: jsm ? "internal" : "ticket" })).ok).toBe(true);
        const attachments = await h.invoke("attachments_list", ref);
        expect(attachments.data.values[0].id).toBe("101");
        const receipt = await h.invoke("attachment_download", { ...ref, attachmentId: "101", destinationName: `${account.id}.bin` });
        expect(receipt.ok).toBe(true); expect(receipt.data.site).toBe(account.siteUrl);
        expect(receipt.data.via).toBe(jsm ? "jsm" : "platform");
      }
      for (const account of c.accounts) expect(used.has(`${account.id}:rest/api/3/user/viewissue/search`)).toBe(true);
    } finally { service.close(); }
  });
});
