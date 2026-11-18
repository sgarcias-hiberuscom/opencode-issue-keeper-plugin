import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { m3Fixture } from "../m3-fixtures.js";
import { config, createService, issue, json, mockFetch } from "../helpers.js";
import { toolHarness } from "../harness.js";
import { planHash } from "../../src/core/proposals.js";
import { verifyRecorded } from "../../src/state/operator.js";

const fixtures: Awaited<ReturnType<typeof m3Fixture>>[] = [];
const scratch: string[] = [];
beforeEach(() => {
  vi.stubEnv("IK_TEST_WORK", "token-before");
  vi.stubEnv("IK_TEST_CLIENT", "client-token");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.close(); await rm(f.root, { recursive: true, force: true }); }
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function fixture() { const f = await m3Fixture(); fixtures.push(f); return f; }
const tokenOf = (init: RequestInit | undefined) => {
  const header = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
  return Buffer.from(header.slice(6), "base64").toString().split(":").slice(1).join(":");
};
const mutationTokens = (f: Awaited<ReturnType<typeof m3Fixture>>) => f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST" || init?.method === "PUT").map(([, init]) => tokenOf(init));

describe("[11.3][10.1][10.4] rotation, identity and recovery", () => {
  it("[11.3][rotation] applies after a tokenFile rotation of the same identity without changing the plan", async () => {
    const f = await fixture();
    const directory = await mkdtemp("/tmp/opencode/ik-rotation-file-"); scratch.push(directory);
    const tokenFile = join(directory, "token");
    await writeFile(tokenFile, "file-before", { mode: 0o600 });
    f.c.accounts[0]!.auth = { mode: "cloud-token", email: f.c.accounts[0]!.auth.email, tokenFile };
    const plan = await f.prepare("comment_prepare", { audience: "ticket", text: "mensaje" });
    const hash = planHash(plan);
    await writeFile(tokenFile, "file-rotated", { mode: 0o600 });
    const result = await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(result.data.state).toBe("applied");
    expect(mutationTokens(f)).toEqual(["file-rotated"]);
    expect(planHash((await f.saved(plan)).plan)).toBe(hash);
  });

  it("[11.3][rotation] applies after a tokenEnv rotation of the same identity without changing the plan", async () => {
    const f = await fixture();
    const plan = await f.prepare("comment_prepare", { audience: "ticket", text: "mensaje" });
    const hash = planHash(plan);
    vi.stubEnv("IK_TEST_WORK", "token-after");
    const result = await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(result.data.state).toBe("applied");
    expect(mutationTokens(f)).toEqual(["token-after"]);
    expect(planHash((await f.saved(plan)).plan)).toBe(hash);
  });

  it("[11.3][revoked] a 401 during revalidation sends nothing and leaves the plan intact", async () => {
    const f = await fixture();
    const plan = await f.prepare("comment_prepare", { audience: "ticket", text: "mensaje" });
    const hash = planHash(plan);
    const base = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => new URL(String(url)).pathname.endsWith("/myself") ? json({}, 401) : base(url, init!));
    vi.stubEnv("IK_TEST_WORK", "token-revoked");
    const result = await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("AUTH_FAILED");
    expect(f.ledger).toHaveLength(0);
    const saved = await f.saved(plan);
    expect(saved.payloadHash).toBe(hash);
    expect(saved.receipts).toEqual({});
    expect(saved.execution.state).not.toBe("applied");
    expect(saved.execution.steps.every((step) => step.state === "pending")).toBe(true);
  });

  it("[11.3][uncertain] rotation does not turn an uncertain step into a retry, by apply or verify", async () => {
    const f = await fixture();
    const file = await f.source();
    const plan = await f.prepare("attachment_upload_prepare", { audience: "ticket", files: [file] });
    f.faults.disconnectAt = 1;
    const uncertain = await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(uncertain.data.state).toBe("unknown");
    vi.stubEnv("IK_TEST_WORK", "token-after");
    f.faults.disconnectAt = 0;
    const again = await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(again.data.state).toBe("unknown");
    const requests = f.fetcher.mock.calls.length;
    expect((await verifyRecorded(plan.id, f.c, { data: f.data, fetcher: f.fetcher })).state).toBe("unknown");
    expect(f.ledger).toHaveLength(1);
    expect(f.fetcher.mock.calls.slice(requests).some(([, init]) => init?.method === "POST" || init?.method === "PUT")).toBe(false);
    expect((await f.saved(plan)).execution.steps[0]!.state).toBe("unknown");
  });

  it("[11.3][jsm] continues only the remainder after a same-identity rotation between JSM phases", async () => {
    const f = await fixture();
    const plan = await f.prepare("attachment_upload_prepare", { audience: "public", files: [await f.source("a.txt"), await f.source("b.txt")] });
    const hash = planHash(plan);
    f.faults.blockAfter = 1;
    expect((await f.harness.invoke("change_apply", { proposalId: plan.id })).error.code).toBe("WRITE_OUTCOME_UNKNOWN");
    const progress = await f.saved(plan);
    expect(progress.receipts["file-1"]!.verifiedAt).toBeDefined();
    const sentBefore = f.ledger.length;
    expect(sentBefore).toBe(1);
    vi.stubEnv("IK_TEST_WORK", "token-after");
    f.faults.blockAfter = 0;
    const result = await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(result.data.state, JSON.stringify(result)).toBe("applied");
    expect(f.ledger).toHaveLength(3);
    expect(f.ledger[0]!.path).toMatch(/attachTemporaryFile$/);
    expect(mutationTokens(f)).toEqual(["token-before", "token-after", "token-after"]);
    expect(planHash((await f.saved(plan)).plan)).toBe(hash);
  });

  it("[11.3][jsm] stops after an identity change between JSM phases and reuses no temporary", async () => {
    const f = await fixture();
    const plan = await f.prepare("attachment_upload_prepare", { audience: "public", files: [await f.source("a.txt"), await f.source("b.txt")] });
    f.faults.blockAfter = 1;
    await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(f.ledger).toHaveLength(1);
    vi.stubEnv("IK_TEST_WORK", "token-other-person");
    f.faults.blockAfter = 0;
    f.faults.identity = "other";
    const result = await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(result.ok && result.data.state === "applied").toBe(false);
    expect(f.ledger).toHaveLength(1);
    expect(f.ledger.some((entry) => JSON.stringify(entry.body).includes("temporaryAttachmentIds"))).toBe(false);
    const saved = await f.saved(plan);
    expect(saved.execution.state).not.toBe("applied");
    expect(saved.execution.steps.some((step) => step.state === "sending")).toBe(false);
    await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(f.ledger).toHaveLength(1);
  });

  it("[11.3][isolation] a revoked account does not affect the reads of another account", async () => {
    const location = await mkdtemp("/tmp/opencode/ik-revoked-"); scratch.push(location);
    await mkdir(location, { recursive: true });
    const c = config();
    c.accounts[1]!.siteUrl = "https://client.atlassian.net";
    const fetcher = mockFetch((url, init) => {
      if (url.hostname === "example.atlassian.net") return json({}, 401);
      expect(tokenOf(init)).toBe("client-token");
      const remote = issue("CL-1", "CL"); remote.fields.project.projectTypeKey = "software";
      return json(remote);
    });
    const service = await createService(c, location, fetcher);
    try {
      const h = await toolHarness(service);
      const revoked = await h.invoke("issue_get", { account: "work", issueKey: "IK-1", fields: ["summary"] });
      expect(revoked.error.code).toBe("AUTH_FAILED");
      for (let i = 0; i < 3; i++) {
        const other = await h.invoke("issue_get", { account: "client", issueKey: "CL-1", fields: ["summary"] });
        expect(other.ok, JSON.stringify(other)).toBe(true);
        expect(other.data.key).toBe("CL-1");
      }
      const states = Object.fromEntries((await service.accounts()).map((account) => [account.account, account.state]));
      expect(states.work).toBe("unavailable");
      expect(states.client).not.toBe("unavailable");
    } finally { service.close(); }
  });
});
