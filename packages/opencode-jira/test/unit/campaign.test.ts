import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const modulePath = new URL("../../scripts/live-write-campaign.mjs", import.meta.url).href;
const { mutationTarget, campaignResult, runCampaign } = await import(modulePath);
const accounts = [
  { id: "qa", siteUrl: "https://qa.atlassian.net", auth: { mode: "cloud-token" } },
  { id: "scoped", siteUrl: "https://qa.atlassian.net", auth: { mode: "cloud-scoped-token", cloudId: "cloud-a" } },
  { id: "other", siteUrl: "https://other.atlassian.net", auth: { mode: "cloud-token" } },
];
const targets = [{ account: "qa", site: accounts[0]!.siteUrl, issueKey: "QA-10", serviceDeskId: "2" }, { account: "scoped", site: accounts[1]!.siteUrl, issueKey: "QA-10", serviceDeskId: "2" }];
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("[INT-01/03][OP-05] bounded opt-in QA campaign", () => {
  for (const [prefix, account] of [["https://qa.atlassian.net", "qa"], ["https://api.atlassian.com/ex/jira/cloud-a", "scoped"]] as const) {
    for (const [method, path] of [["PUT", "/rest/api/3/issue/QA-10"], ["POST", "/rest/api/3/issue/QA-10/comment"], ["POST", "/rest/api/3/issue/QA-10/transitions"], ["POST", "/rest/api/3/issue/QA-10/attachments"], ["POST", "/rest/servicedeskapi/request/QA-10/comment"], ["POST", "/rest/servicedeskapi/request/QA-10/attachment"], ["POST", "/rest/servicedeskapi/servicedesk/2/attachTemporaryFile"]] as const) {
      it(`allows only declared ${account} ${method} ${path}`, () => {
        expect(mutationTarget(accounts, targets, prefix + path, method).account).toBe(account);
      });
    }
  }
  it.each([
    ["https://other.atlassian.net/rest/api/3/issue/QA-10/comment", "POST"],
    ["https://qa.atlassian.net.attacker.invalid/rest/api/3/issue/QA-10/comment", "POST"],
    ["http://qa.atlassian.net/rest/api/3/issue/QA-10/comment", "POST"],
    ["https://qa.atlassian.net/rest/api/3/issue/QA-1/comment", "POST"],
    ["https://qa.atlassian.net/rest/api/3/issue/QA-100/comment", "POST"],
    ["https://qa.atlassian.net/rest/api/3/issue/QA-10/comment?notifyUsers=false", "POST"],
    ["https://qa.atlassian.net/rest/api/3/issue/QA-10/comment#fragment", "POST"],
    ["https://user:secret@qa.atlassian.net/rest/api/3/issue/QA-10/comment", "POST"],
    ["https://qa.atlassian.net/rest/api/3/issue/QA-10", "DELETE"],
    ["https://qa.atlassian.net/rest/api/3/issue", "POST"],
    ["https://qa.atlassian.net/rest/servicedeskapi/servicedesk/3/attachTemporaryFile", "POST"],
    ["https://api.atlassian.com/ex/jira/cloud-b/rest/api/3/issue/QA-10/comment", "POST"],
    ["https://api.atlassian.com/rest/api/3/issue/QA-10/comment", "POST"],
  ])("rejects undeclared mutation %s %s", (url, method) => {
    expect(() => mutationTarget(accounts, targets, url, method)).toThrow();
  });
  it("never turns instrumented acceptance into human, G3 or G4 evidence", () => {
    const result = campaignResult({ variants: [{ status: "passed" }], ledger: [{ state: "confirmed" }] });
    expect(result).toMatchObject({ automatic: "passed", humanDecision: false, G3: "pending", G4: "pending", uncertain: 0 });
  });
  it.each(["running", "failed", "blocked", "skipped"])("does not count %s as passed", (status) => {
    expect(campaignResult({ variants: [{ status }], ledger: [] }).automatic).toBe("incomplete");
  });
  it.each(["sending", "unknown"])("preserves unresolved %s as incomplete even with passed variants", (state) => {
    expect(campaignResult({ variants: [{ status: "passed" }], ledger: [{ state }] })).toMatchObject({ automatic: "incomplete", uncertain: 1 });
  });
  it("does not approve an empty or interrupted campaign", () => {
    expect(campaignResult({ variants: [], ledger: [] }).automatic).toBe("incomplete");
    expect(campaignResult({ variants: [{ status: "passed" }], ledger: [], failure: "interrupted" }).automatic).toBe("incomplete");
  });
  it("distinguishes an HTTP acknowledgment from a verified execution", () => {
    expect(campaignResult({ variants: [{ status: "passed", execution: { state: "unknown" } }], ledger: [{ state: "confirmed" }] })).toMatchObject({ automatic: "incomplete", uncertain: 0, unresolvedExecutions: 1 });
  });
  it.each(["authorization", "site", "account", "target", "budget", "input", "duplicate", "kind", "original-change"])("rejects unsafe %s before package loading, state or network", async (invalid) => {
    const root = await mkdtemp("/tmp/opencode/jira-campaign-test-"); roots.push(root);
    const manifest = { version: 1, targets: structuredClone(targets), maxMutations: 5, scenarios: [{ id: "one", account: "qa", issueKey: "QA-10", kind: "comment", input: { text: "synthetic", audience: "ticket" } as Record<string, unknown> }] };
    if (invalid === "site") manifest.targets[0]!.site = "https://other.atlassian.net";
    if (invalid === "account") manifest.targets[0]!.account = "missing";
    if (invalid === "target") manifest.scenarios[0]!.issueKey = "QA-11";
    if (invalid === "budget") manifest.maxMutations = 101;
    if (invalid === "input") manifest.scenarios[0]!.input.expectedUpdated = "forged";
    if (invalid === "duplicate") manifest.scenarios.push(structuredClone(manifest.scenarios[0]!));
    if (invalid === "kind") manifest.scenarios[0]!.kind = "http";
    if (invalid === "original-change") Object.assign(manifest.scenarios[0]!, { modifyOriginalAfterPreparation: true });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(runCampaign({ installed: join(root, "nonexistent-package"), configuration: { accounts }, manifest, output: join(root, "output"), authorized: invalid !== "authorization" })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
  });
});
