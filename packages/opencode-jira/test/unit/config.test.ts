import { describe, expect, it } from "vitest";
import { parseConfig, downloadDirectory } from "../../src/config.js";
import { rawAccount } from "../helpers.js";
import { apiUrl } from "../../src/http.js";
import * as inputs from "../../src/tools/schemas.js";

describe("configuration", () => {
  it("applies safe documented defaults", () => {
    const c = parseConfig({ accounts: [rawAccount()] });
    expect(c.http).toEqual({ timeoutMs: 20000, readMaxAttempts: 3, maxResponseBytes: 1048576, maxConcurrentPerAccount: 3 });
    expect(c.attachments).toMatchObject({ overwrite: false, maxFileBytes: 20971520, downloadDir: ".issuekeeper/downloads" });
    expect(c.accounts[0]?.readOnly).toBe(true);
  });
  it.each([
    { restrictedProjects: [] }, { restrictedProjects: ["CONFIDENCIAL"] }, { restrictedUpdateFields: ["assignee", "customfield_10042"] },
  ])("[4.5][E04][CF-04] accepts optional exclusion lists (%#)", (restriction) => {
    expect(parseConfig({ accounts: [{ ...rawAccount(), ...restriction }] }).accounts).toHaveLength(1);
  });
  it.each([
    { accounts: [rawAccount(), rawAccount()] },
    { accounts: [rawAccount()], defaultAccount: "missing" },
    { accounts: [{ ...rawAccount(), id: "Work" }] },
    { accounts: [{ ...rawAccount(), restrictedProjects: ["conf"] }] },
    { accounts: [{ ...rawAccount(), restrictedProjects: [""] }] },
    { accounts: [{ ...rawAccount(), restrictedProjects: ["CONF*"] }] },
    { accounts: [{ ...rawAccount(), restrictedUpdateFields: ["a b"] }] },
    { accounts: [{ ...rawAccount(), restrictedUpdateFields: [""] }] },
    { accounts: [{ ...rawAccount(), allowedProjects: ["IK"] }] },
    { accounts: [{ ...rawAccount(), allowedUpdateFields: [] }] },
    { accounts: [{ ...rawAccount(), allowedReadFields: ["comment"] }] },
    { accounts: [{ ...rawAccount(), allowedReadFields: ["attachment"] }] },
    { accounts: [{ ...rawAccount(), auth: { ...rawAccount().auth, tokenFile: "/secret" } }] },
    { accounts: [{ ...rawAccount(), auth: { ...rawAccount().auth, tokenEnv: undefined, tokenFile: "~/secret" } }] },
    { accounts: [{ ...rawAccount(), auth: { ...rawAccount().auth, tokenEnv: undefined, tokenFile: "relative/token" } }] },
    { accounts: [{ ...rawAccount(), auth: { mode: "cloud-token", email: "user@example.com" } }] },
    { accounts: [{ ...rawAccount(), auth: { ...rawAccount().auth, mode: "cloud-scoped-token" } }] },
    { accounts: [{ ...rawAccount(), auth: { ...rawAccount().auth, cloudId: "11111111-2222-4333-8444-555555555555" } }] },
    { accounts: [rawAccount()], http: { timeoutMs: 0 } },
    { accounts: [rawAccount()], http: { timeoutMs: 1.5 } },
    { accounts: [rawAccount()], http: { readMaxAttempts: -1 } },
    { accounts: [rawAccount()], attachments: { maxFileBytes: 100, maxBatchBytes: 99 } },
    { accounts: [rawAccount()], output: { maxPageSize: 10 } },
    { accounts: [rawAccount()], attachments: { overwrite: true } },
    { accounts: [rawAccount()], token: "secret-dont-echo" },
  ])("rejects invalid options without echoing their values (%#)", (raw) => {
    expect(() => parseConfig(raw)).toThrow("Configuración inválida");
    try { parseConfig(raw); } catch (error) { expect(String(error)).not.toContain("secret-dont-echo"); }
  });
  it.each(["http://example.atlassian.net", "https://user:pass@example.atlassian.net", "https://evil.com", "https://a.atlassian.net.evil.com", "https://a.atlassian.net/path", "https://a.atlassian.net/x/..", "https://a.atlassian.net/?q=x", "https://a.atlassian.net/#hash", "https://a.atlassian.net:444"])('rejects site %s', (siteUrl) => {
    expect(() => parseConfig({ accounts: [{ ...rawAccount(), siteUrl }] })).toThrow();
  });
  it("preserves scoped gateway prefix and separates the web origin", () => {
    const c = parseConfig({ accounts: [{ ...rawAccount(), auth: { ...rawAccount().auth, mode: "cloud-scoped-token", cloudId: "11111111-2222-4333-8444-555555555555" } }] });
    expect(apiUrl(c.accounts[0]!, "rest/servicedeskapi/request/IK-1/comment").href).toBe("https://api.atlassian.com/ex/jira/11111111-2222-4333-8444-555555555555/rest/servicedeskapi/request/IK-1/comment");
    expect(apiUrl(c.accounts[0]!, "rest/api/3/issue/IK-1/transitions").pathname).toBe("/ex/jira/11111111-2222-4333-8444-555555555555/rest/api/3/issue/IK-1/transitions");
    for (const path of ["https://evil.com", "/rest/api/3/myself", "rest/api/3/issue/../myself", "rest/api/3/search", "rest/api/3/issue/IK-1/delete", "rest/api/3/issue/IK-1/transitions/../comment"]) expect(() => apiUrl(c.accounts[0]!, path)).toThrow();
  });
  it("restricts download destination to the location, outside metadata", () => {
    const c = parseConfig({ accounts: [rawAccount()] });
    expect(downloadDirectory(c, "/workspace")).toBe("/workspace/.issuekeeper/downloads");
    for (const downloadDir of ["../other", ".", ".git/objects", "secrets/files", "/elsewhere"]) {
      c.attachments.downloadDir = downloadDir;
      expect(() => downloadDirectory(c, "/workspace")).toThrow();
    }
  });
});

describe("tool argument contracts", () => {
  it("normalizes issue keys but rejects URL injection, IDs and unknown keys", () => {
    expect(inputs.GetInput.parse({ account: "work", issueKey: "ik-123" }).issueKey).toBe("IK-123");
    for (const issueKey of ["123", "IK-0", "IK-1?fields=*all", "IK-1/../../myself", "https://evil.com"]) expect(inputs.GetInput.safeParse({ account: "work", issueKey }).success).toBe(false);
    expect(inputs.GetInput.safeParse({ account: "work", issueKey: "IK-1", token: "not-an-input" }).success).toBe(false);
  });
  it("accepts JQL but rejects old filters, wildcard fields and traversal", () => {
    expect(inputs.SearchInput.safeParse({ account: "work", jql: "project = IK" }).success).toBe(true);
    expect(inputs.SearchInput.safeParse({ account: "work", project: "IK", jql: "ORDER BY key" }).success).toBe(false);
    expect(inputs.GetInput.safeParse({ account: "work", issueKey: "IK-1", fields: ["*all"] }).success).toBe(false);
    for (const destinationName of ["../secret", "/tmp/file", ".git", "a\\b", "a\0b"]) expect(inputs.DownloadInput.safeParse({ account: "work", issueKey: "IK-1", attachmentId: "101", destinationName }).success).toBe(false);
  });
  it.each(["comment", "attachment", "worklog", "*all"])("[LEC-01] rejects embedded field %s", (field) => {
    expect(inputs.GetInput.safeParse({ account: "work", issueKey: "IK-1", fields: [field] }).success).toBe(false);
  });
  it("[MEN-01] requires a unique query mode and audience-compatible visibility", () => {
    const ref = { account: "work", issueKey: "IK-1", audience: "ticket", query: "Ana" };
    expect(inputs.MentionsInput.safeParse(ref).success).toBe(true);
    expect(inputs.MentionsInput.safeParse({ ...ref, accountId: "abc" }).success).toBe(false);
    expect(inputs.MentionsInput.safeParse({ ...ref, audience: "internal", visibility: { type: "role", value: "Team" } }).success).toBe(false);
    expect(inputs.GetInput.safeParse({ account: "work", issueKey: "IK-1", fields: Array(31).fill("summary") }).success).toBe(false);
    expect(inputs.SearchInput.safeParse({ account: "work", jql: "project = IK", maxResults: 101 }).success).toBe(false);
  });
});
