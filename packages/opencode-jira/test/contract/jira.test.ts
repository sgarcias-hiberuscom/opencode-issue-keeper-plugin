import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JiraCloud } from "../../src/jira/cloud.js";
import { HttpClient } from "../../src/http.js";
import { config, issue, json, mockFetch, request, signal, attachment } from "../helpers.js";

beforeEach(() => { vi.stubEnv("IK_TEST_WORK", "work-secret"); vi.stubEnv("IK_TEST_CLIENT", "client-secret"); });
afterEach(() => vi.unstubAllEnvs());

describe("Jira Platform reads", () => {
  it("[5.4][E02][BU-01] searches bounded JQL with an opaque scoped cursor", async () => {
    const c = config(); let count = 0;
    const fetcher = mockFetch((url, init) => {
      expect(url.pathname).toBe("/rest/api/3/search/jql");
      const body = JSON.parse(String(init.body));
      expect(body.jql).toBe('(project = "IK" AND assignee = currentUser() AND statusCategory != Done) AND project NOT IN ("OTHER") ORDER BY updated DESC, key ASC');
      expect(body.fields).toEqual(expect.arrayContaining(["summary", "status", "updated", "project"]));
      if (++count === 1) return json({ issues: [issue()], nextPageToken: "next-token", isLast: false });
      expect(body.nextPageToken).toBe("next-token");
      return json({ issues: [], isLast: true });
    });
    const provider = new JiraCloud(c, new HttpClient(c, fetcher));
    const input = { account: "work", jql: 'project = "IK" AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC, key ASC', maxResults: 2 };
    const first = await provider.search(c.accounts[0]!, input, signal());
    expect(first.data.isLast).toBe(false); expect(first.data.cursor).not.toContain("next-token");
    await expect(provider.search(c.accounts[1]!, { ...input, account: "client", cursor: first.data.cursor }, signal())).rejects.toMatchObject({ code: "CURSOR_INVALID" });
    await expect(provider.search(c.accounts[0]!, { ...input, fields: ["summary"], cursor: first.data.cursor }, signal())).rejects.toMatchObject({ code: "CURSOR_INVALID" });
    const second = await provider.search(c.accounts[0]!, { ...input, cursor: first.data.cursor }, signal());
    expect(second.data).toEqual({ values: [], isLast: true, cursor: undefined });
    expect(fetcher).toHaveBeenCalledTimes(2); provider.close();
  });
  it("rejects repeated search tokens and disallowed returned projects", async () => {
    const c = config(); const fetcher = mockFetch(() => json({ issues: [issue()], nextPageToken: "same" }));
    const provider = new JiraCloud(c, new HttpClient(c, fetcher));
    const input = { account: "work", jql: "project = IK" };
    const first = await provider.search(c.accounts[0]!, input, signal());
    await expect(provider.search(c.accounts[0]!, { ...input, cursor: first.data.cursor }, signal())).rejects.toMatchObject({ code: "CURSOR_INVALID" });
    fetcher.mockImplementation(async () => json({ issues: [issue("OTHER-1", "OTHER")] }));
    expect((await provider.search(c.accounts[0]!, input, signal())).data.values).toEqual([]);
    expect((await provider.search(c.accounts[0]!, { ...input, jql: "project = OTHER" }, signal())).data.values).toEqual([]);
    provider.close();
  });
  it("preserves canonical ID/key, minimizes identities and checks the real project", async () => {
    const c = config(); const fetcher = mockFetch(() => json(issue("IK-2")));
    const provider = new JiraCloud(c, new HttpClient(c, fetcher)); const authorize = vi.fn(async () => {});
    const result = await provider.get(c.accounts[0]!, { account: "work", issueKey: "IK-1" }, signal(), authorize);
    expect(result.data).toMatchObject({ id: "10001", key: "IK-2", account: "work", url: "https://example.atlassian.net/browse/IK-2", descriptionText: "Untrusted text" });
    expect(JSON.stringify(result)).not.toContain("emailAddress");
    expect(authorize).toHaveBeenCalledWith("IK-2", "IK");
    fetcher.mockImplementation(async () => json(issue("OTHER-1", "OTHER")));
    await expect(provider.get(c.accounts[0]!, { account: "work", issueKey: "IK-1" }, signal())).rejects.toMatchObject({ code: "FORBIDDEN" });
    provider.close();
  });
  it("keeps accounts explicit even for identical keys on one site", async () => {
    const c = config(); const identities: string[] = [];
    const fetcher = mockFetch((_, init) => {
      const auth = (init.headers as Record<string, string>).Authorization!;
      identities.push(Buffer.from(auth.slice(6), "base64").toString());
      return json(issue());
    });
    const provider = new JiraCloud(c, new HttpClient(c, fetcher));
    const values = await Promise.all(c.accounts.map((a) => provider.get(a, { account: a.id, issueKey: "IK-1" }, signal())));
    expect(values.map((v) => v.data.account)).toEqual(["work", "client"]);
    expect(identities).toEqual(["work@example.com:work-secret", "client@example.com:client-secret"]);
    provider.close();
  });
  it("[5.5][E03][LE-02] returns custom fields only when explicitly selected", async () => {
    const c = config();
    const fetcher = mockFetch(() => json({ ...issue(), fields: { ...issue().fields, customfield_10042: { value: "approved" }, customfield_99999: "not-authorized" } }));
    const provider = new JiraCloud(c, new HttpClient(c, fetcher));
    const result = await provider.get(c.accounts[0]!, { account: "work", issueKey: "IK-1", fields: ["customfield_10042"] }, signal());
    expect(result.data.customFields).toEqual({ customfield_10042: { value: "approved" } });
    expect(JSON.stringify(result)).not.toContain("not-authorized"); provider.close();
  });
  it("paginates Platform comments by offset, not by search token", async () => {
    const c = config(); const offsets: string[] = [];
    const fetcher = mockFetch((url) => {
      if (!url.pathname.endsWith("/comment")) return json(issue());
      offsets.push(url.searchParams.get("startAt")!);
      const startAt = Number(url.searchParams.get("startAt"));
      return json({ startAt, maxResults: 1, total: 2, comments: [{ id: String(startAt + 1), body: issue().fields.description, visibility: { type: "role", value: "Team" } }] });
    });
    const provider = new JiraCloud(c, new HttpClient(c, fetcher));
    const input = { account: "work", issueKey: "IK-1", maxResults: 1 };
    const first = await provider.comments(c.accounts[0]!, input, signal());
    const second = await provider.comments(c.accounts[0]!, { ...input, cursor: first.data.cursor }, signal());
    expect(offsets).toEqual(["0", "1"]); expect(second.data.isLast).toBe(true);
    expect(first.data.values[0]).toMatchObject({ text: "Untrusted text", audience: "ticket", visibility: { type: "role", value: "Team" } });
    await expect(provider.comments(c.accounts[0]!, { ...input, audience: "internal" }, signal())).rejects.toMatchObject({ code: "CAPABILITY_NOT_SUPPORTED" });
    provider.close();
  });
  it("pages Platform attachment metadata locally and never follows content links", async () => {
    const c = config(); const fetcher = mockFetch((url) => url.searchParams.get("fields") === "attachment,project"
      ? json({ id: "10001", fields: { project: issue().fields.project, attachment: [attachment, { ...attachment, id: "102", content: "https://evil.com" }] } }) : json(issue()));
    const provider = new JiraCloud(c, new HttpClient(c, fetcher));
    const input = { account: "work", issueKey: "IK-1", maxResults: 1 };
    const first = await provider.attachments(c.accounts[0]!, input, signal());
    const second = await provider.attachments(c.accounts[0]!, { ...input, cursor: first.data.cursor }, signal());
    expect(first.data.values[0]?.audience).toBe("unknown");
    expect(second.data.values[0]?.id).toBe("102"); expect(second.data.isLast).toBe(true);
    expect(JSON.stringify(second)).not.toContain("evil.com"); provider.close();
  });
});

describe("JSM agent/customer contract", () => {
  it.each([
    { start: 1, limit: 25, size: 0, isLastPage: true, values: [] },
    { start: 0, limit: 25, size: 2, isLastPage: true, values: [] },
    { start: 0, limit: 25, size: 0, isLastPage: false, values: [] },
    { start: 0, limit: 1, size: 2, isLastPage: true, values: [{ id: "a", body: "x", public: true }, { id: "b", body: "x", public: true }] },
  ])("[10.2][E03][HT-05] rejects inconsistent JSM pages (%#)", async (page) => {
    const c = config(true);
    const fetcher = mockFetch((url) => url.pathname.endsWith("/comment") ? json(page) : url.pathname.includes("/api/3/issue/") ? json(issue()) : json(request()));
    const provider = new JiraCloud(c, new HttpClient(c, fetcher));
    try {
      await expect(provider.comments(c.accounts[0]!, { account: "work", issueKey: "IK-1" }, signal())).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    } finally { provider.close(); }
  });
  it("detects a request and filters public/internal comments without fallback", async () => {
    const c = config(true); const calls: string[] = [];
    const fetcher = mockFetch((url) => {
      calls.push(url.pathname);
      if (url.pathname.includes("/api/3/issue/")) return json(issue());
      if (url.pathname.endsWith("/comment")) {
        expect(url.searchParams.get("public")).toBe("false"); expect(url.searchParams.get("internal")).toBe("true");
        return json({ start: 0, limit: 25, size: 1, isLastPage: true, values: [{ id: "internal-1", body: "private note", public: false }] });
      }
      expect(url.searchParams.get("expand")).toBe("serviceDesk"); return json(request());
    });
    const provider = new JiraCloud(c, new HttpClient(c, fetcher));
    const result = await provider.comments(c.accounts[0]!, { account: "work", issueKey: "IK-1", audience: "internal" }, signal());
    expect(result.data.values[0]?.audience).toBe("internal");
    expect(calls).not.toContain("/rest/api/3/issue/IK-1/comment"); provider.close();
  });
  it("supports a portal-only customer using the actual expanded service desk project", async () => {
    const c = config(true); const fetcher = mockFetch((url) => {
      if (url.pathname.includes("/api/3/issue/")) return json({}, 403);
      if (url.pathname.endsWith("/comment")) return json({ start: 0, limit: 25, size: 0, isLastPage: true, values: [] });
      return json(request());
    });
    const provider = new JiraCloud(c, new HttpClient(c, fetcher));
    const ticket = await provider.get(c.accounts[1]!, { account: "client", issueKey: "IK-1" }, signal());
    expect(ticket.data).toMatchObject({ source: "jsm-request", project: { id: "10", key: "IK" }, serviceRequest: { serviceDeskId: "20", requestTypeId: "30" } });
    expect(ticket.data.updated).toBeUndefined();
    const result = await provider.comments(c.accounts[1]!, { account: "client", issueKey: "IK-1", audience: "internal" }, signal());
    expect(result.data.values).toEqual([]); expect(result.warnings.join(" ")).toContain("no demuestra");
    provider.close();
  });
  it("never infers project policy from the caller's issue prefix", async () => {
    const c = config(true); const fetcher = mockFetch((url) => url.pathname.includes("/api/3/issue/") ? json({}, 403) : json({ ...request(), serviceDesk: { id: "20", projectId: "99", projectKey: "OTHER" } }));
    const provider = new JiraCloud(c, new HttpClient(c, fetcher));
    await expect(provider.get(c.accounts[1]!, { account: "client", issueKey: "IK-1" }, signal())).rejects.toMatchObject({ code: "FORBIDDEN" }); provider.close();
  });
  it("uses start/limit for attachments and leaves their undeclared visibility unknown", async () => {
    const c = config(true); const fetcher = mockFetch((url) => {
      if (url.pathname.includes("/api/3/issue/")) return json(issue());
      if (url.pathname.endsWith("/attachment")) {
        const start = Number(url.searchParams.get("start"));
        return json({ start, limit: 1, size: 1, isLastPage: start === 1, values: [{ filename: "file.txt", size: 5, mimeType: "text/plain", _links: { jiraRest: `https://example.atlassian.net/rest/api/2/attachment/${101 + start}`, content: "https://evil.com/signed" } }] });
      }
      return json(request());
    });
    const provider = new JiraCloud(c, new HttpClient(c, fetcher)); const input = { account: "work", issueKey: "IK-1", maxResults: 1 };
    const first = await provider.attachments(c.accounts[0]!, input, signal());
    const second = await provider.attachments(c.accounts[0]!, { ...input, cursor: first.data.cursor }, signal());
    expect(second.data.values[0]).toMatchObject({ id: "102", audience: "unknown" });
    expect(second.data.isLast).toBe(true); provider.close();
  });
  it.each([403, 404])("does not fall back to Platform comments on JSM %i", async (status) => {
    const c = config(true); const paths: string[] = [];
    const fetcher = mockFetch((url) => { paths.push(url.pathname); return url.pathname.includes("/api/3/issue/") ? json(issue()) : json({}, status); });
    const provider = new JiraCloud(c, new HttpClient(c, fetcher));
    await expect(provider.comments(c.accounts[0]!, { account: "work", issueKey: "IK-1" }, signal())).rejects.toMatchObject({ code: "CAPABILITY_NOT_SUPPORTED" });
    expect(paths).not.toContain("/rest/api/3/issue/IK-1/comment"); provider.close();
  });
  it("preserves the scoped gateway for JSM and accepts only its own metadata prefix", async () => {
    const c = config(true);
    c.accounts[0]!.auth = { ...c.accounts[0]!.auth, mode: "cloud-scoped-token", cloudId: "11111111-2222-4333-8444-555555555555" };
    const prefix = "/ex/jira/11111111-2222-4333-8444-555555555555";
    const fetcher = mockFetch((url) => {
      expect(url.origin).toBe("https://api.atlassian.com"); expect(url.pathname.startsWith(prefix)).toBe(true);
      if (url.pathname.endsWith("/attachment")) return json({ start: 0, limit: 25, size: 1, isLastPage: true, values: [{ filename: "file.txt", size: 5, mimeType: "text/plain", _links: { jiraRest: `https://api.atlassian.com${prefix}/rest/api/2/attachment/101` } }] });
      return url.pathname.includes("/api/3/issue/") ? json(issue()) : json(request());
    });
    const provider = new JiraCloud(c, new HttpClient(c, fetcher));
    expect((await provider.attachments(c.accounts[0]!, { account: "work", issueKey: "IK-1" }, signal())).data.values[0]?.id).toBe("101");
    provider.close();
  });
  it("rejects a comment response that contradicts the requested audience", async () => {
    const c = config(true); const fetcher = mockFetch((url) => {
      if (url.pathname.endsWith("/comment")) return json({ start: 0, limit: 25, size: 1, isLastPage: true, values: [{ id: "private", public: false, body: "not-public" }] });
      return url.pathname.includes("/api/3/issue/") ? json(issue()) : json(request());
    });
    const provider = new JiraCloud(c, new HttpClient(c, fetcher));
    await expect(provider.comments(c.accounts[0]!, { account: "work", issueKey: "IK-1", audience: "public" }, signal())).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    provider.close();
  });
});
