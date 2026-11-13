import { vi } from "vitest";
import { parseConfig } from "../src/config.js";

export function rawAccount(id = "work", jsm = false) {
  return {
    id, siteUrl: "https://example.atlassian.net",
    auth: { mode: "cloud-token", email: `${id}@example.com`, tokenEnv: `IK_TEST_${id.toUpperCase()}` },
    readOnly: true, serviceManagement: { enabled: jsm }, allowedProjects: ["IK"], allowedUpdateFields: [],
  };
}
export function config(jsm = false) { return parseConfig({ accounts: [rawAccount("work", jsm), rawAccount("client", jsm)] }); }
export function issue(key = "IK-1", project = "IK") {
  return {
    id: "10001", key,
    fields: {
      project: { id: "10", key: project }, updated: "2026-11-04T09:35:12.000+0000", summary: "Example issue",
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
    currentStatus: { status: "Waiting for support" }, reporter: { accountId: "customer" },
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
