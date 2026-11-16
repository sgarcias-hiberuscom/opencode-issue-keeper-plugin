import { vi } from "vitest";
import { parseConfig } from "../src/config.js";
import type { Config } from "../src/config.js";
import { Service } from "../src/core/service.js";
import { JiraCloud } from "../src/jira/cloud.js";
import { HttpClient } from "../src/http.js";
export function createService(c: Config, location: string, fetcher?: typeof fetch) {
  return Service.create(c, location, new JiraCloud(c, new HttpClient(c, fetcher)));
}

export function rawAccount(id = "work", jsm = false) {
  return {
    id, siteUrl: "https://example.atlassian.net",
    auth: { mode: "cloud-token", email: `${id}@example.com`, tokenEnv: `IK_TEST_${id.toUpperCase()}` },
    readOnly: true, serviceManagement: { enabled: jsm }, restrictedProjects: ["OTHER"], restrictedUpdateFields: [],
  };
}
export function config(jsm = false) { return parseConfig({ accounts: [rawAccount("work", jsm), rawAccount("client", jsm)] }); }
export function issue(key = "IK-1", project = "IK") {
  return {
    id: "10001", key,
    fields: {
      project: { id: "10", key: project, projectTypeKey: "service_desk" }, updated: "2026-11-04T09:35:12.000+0000", summary: "Example issue",
      status: { id: "3", name: "In Progress" }, labels: ["read"],
      description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Untrusted text" }] }] },
      reporter: { accountId: "customer", displayName: "Customer", emailAddress: "not-returned@example.com" },
      assignee: null,
    },
  };
}
export function request() {
  return { issueId: "10001", issueKey: "IK-1", summary: "Portal request", serviceDeskId: "20", requestTypeId: "30",
    serviceDesk: { id: "20", projectId: "10", projectKey: "IK" },
    currentStatus: { status: "Waiting for support" }, reporter: { accountId: "customer", displayName: "Customer" },
    requestFieldValues: [{ fieldId: "description", value: "Portal text" }],
  };
}
export const attachment = { id: "101", filename: "example.txt", size: 5, mimeType: "text/plain" };
export function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}
export function mockFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async (url, init) => handler(new URL(String(url)), init ?? {}));
}
export const signal = () => new AbortController().signal;
export function configEmpty() { return parseConfig({ accounts: [] }); }
export function configTwoSites() {
  const c = config();
  c.accounts[1]!.siteUrl = "https://client.atlassian.net";
  c.accounts[1]!.auth = { ...c.accounts[1]!.auth, mode: "cloud-scoped-token", cloudId: "11111111-2222-4333-8444-555555555555" };
  return c;
}
