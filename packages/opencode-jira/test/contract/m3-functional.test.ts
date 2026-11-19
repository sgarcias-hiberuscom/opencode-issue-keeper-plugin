import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { m3Fixture } from "../m3-fixtures.js";
import { planHash } from "../../src/core/proposals.js";
import { verifyRecorded } from "../../src/state/operator.js";
import { ChangeStore } from "../../src/state/store.js";

const fixtures: Awaited<ReturnType<typeof m3Fixture>>[] = [];
beforeEach(() => vi.stubEnv("IK_TEST_WORK", "synthetic-token"));
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.close(); await rm(f.root, { recursive: true, force: true }); } vi.unstubAllEnvs(); });
async function fixture(scoped = false) { const f = await m3Fixture(scoped); fixtures.push(f); return f; }
const destinations = ["ticket", "internal", "public"] as const;

describe("[M3][MET/APL/REG][AT/TR] functional tools", () => {
  it("keeps the empty base usable with fifteen tools and rejects changes without remote permissions or I/O", async () => {
    const f = await fixture(); f.c.accounts = [];
    expect(f.harness.tools.size).toBe(15); expect(f.fetcher).not.toHaveBeenCalled();
    const result = await f.harness.invoke("comment_prepare", { account: "work", issueKey: "IK-1", expectedUpdated: f.remote.fields.updated, audience: "ticket", text: "x" }); expect(result.error.code).toBe("ACCOUNT_UNAVAILABLE");
    expect((await f.harness.invoke("change_apply", { proposalId: "nonexistent" })).error.code).toBe("PROPOSAL_INVALID");
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.harness.assert).not.toHaveBeenCalled();
  });
  it("never accepts an apply payload or account supplied by the model", async () => {
    const f = await fixture(); const result = await f.harness.invoke("change_apply", { proposalId: "any", account: "work", confirmed: true, payload: {} });
    expect(result.error.code).toBe("VALIDATION_FAILED"); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.harness.assert).not.toHaveBeenCalled();
  });
  it("does not reveal a proposal alias or read Jira from another session in the same location", async () => {
    const f = await fixture(); const plan = await f.prepare("comment_prepare", { audience: "ticket", text: "privado" }); f.fetcher.mockClear(); f.harness.assert.mockClear();
    f.harness.session.mockResolvedValue({ id: "other-session", location: { directory: f.location } });
    const result = await f.harness.invoke("change_apply", { proposalId: plan.id }, new AbortController().signal, "other-session");
    expect(result.ok).toBe(false); expect(result).not.toHaveProperty("account"); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.harness.assert).not.toHaveBeenCalled();
  });
  it("revalidates location after a native write wait before any remote mutation", async () => {
    const f = await fixture(); const plan = await f.prepare("comment_prepare", { audience: "public", text: "x" });
    f.harness.assert.mockImplementation(async (request: unknown) => { if ((request as { action: string }).action === "jira.write") f.harness.session.mockResolvedValue({ id: "session-1", location: { directory: f.root } }); });
    expect((await f.harness.invoke("change_apply", { proposalId: plan.id })).ok).toBe(false); expect(f.ledger).toHaveLength(0);
  });
  it.each(["issue_update_prepare", "comment_prepare", "transition_prepare", "attachment_upload_prepare", "issue_edit_metadata", "transitions_list", "change_apply"])("rejects missing required arguments for %s without I/O", async (tool) => {
    const f = await fixture(); const result = await f.harness.invoke(tool, {}); expect(result.error.code).toBe("VALIDATION_FAILED"); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.harness.assert).not.toHaveBeenCalled();
  });
  it("registers the exact fifteen and keeps metadata free of local restrictions without hiding transition requirements", async () => {
    const f = await fixture(); expect(f.harness.tools.size).toBe(15);
    f.c.accounts[0]!.restrictedUpdateFields = ["summary"];
    const metadata = await f.harness.invoke("issue_edit_metadata", { account: "work", issueKey: "IK-1" });
    expect(metadata.data.fields.some((field: { id: string }) => field.id === "summary")).toBe(false);
    const transitions = await f.harness.invoke("transitions_list", { account: "work", issueKey: "IK-1" });
    expect(transitions.data.transitions[0].fields).toContainEqual(expect.objectContaining({ id: "summary", required: true })); expect(f.ledger).toHaveLength(0);
  });
  it("[5.6][ME-01] explains that unverified candidates are not a denial and comment_prepare validates mentions", async () => {
    const f = await fixture();
    const candidates = f.harness.tools.get("mention_candidates")!.description;
    expect(candidates).toContain("unverified no es una denegación");
    expect(candidates).toContain("comment_prepare");
    expect(candidates).toContain("MENTION_NOT_ALLOWED");
    const prepare = f.harness.tools.get("comment_prepare")!.description;
    expect(prepare).toContain("MENTION_NOT_ALLOWED");
    expect(prepare).toContain("aunque los candidatos figuren como unverified");
    const apply = f.harness.tools.get("change_apply")!.description;
    expect(apply).toContain("llama directamente");
    expect(apply).toContain("FORBIDDEN");
    expect(apply).toContain("no pidas al usuario confirmación adicional");
    expect(apply).toContain("PROPOSAL_INVALID");
    expect(apply).toContain("no reenvíes ese ID ni ofrezcas hacerlo");
  });
  it.each([false, true])("prepares, journals, verifies and deduplicates incremental fields (scoped=%s)", async (scoped) => {
    const f = await fixture(scoped); const plan = await f.prepare("issue_update_prepare", { update: { labels: [{ add: "new" }, { remove: "read" }] } });
    expect(f.ledger).toHaveLength(0); const hash = planHash(plan);
    const result = await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(result.data.state).toBe("applied"); expect(result.account).toBe("work"); expect(f.remote.fields.labels).toEqual(["new"]);
    await f.harness.invoke("change_apply", { proposalId: plan.id }); expect(f.ledger).toHaveLength(1); expect(planHash((await f.saved(plan)).plan)).toBe(hash);
  });
  it("validates existing required transition fields freshly rather than requiring arbitrary replacements", async () => {
    const f = await fixture(); const plan = await f.prepare("transition_prepare", { transitionId: "31" });
    expect(f.ledger).toHaveLength(0); const result = await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(result.data.state).toBe("applied"); expect(f.remote.fields.status.id).toBe("4"); expect(f.ledger).toHaveLength(1);
  });
  it.each(["before-apply", "during-permission"])("blocks a removed transition %s without changing the approved plan", async (point) => {
    const f = await fixture(); const plan = await f.prepare("transition_prepare", { transitionId: "31" }); const hash = planHash(plan);
    if (point === "before-apply") f.faults.transitionAvailable = false;
    else f.harness.assert.mockImplementation(async (request: unknown) => { if ((request as { action: string }).action === "jira.write") f.faults.transitionAvailable = false; });
    const result = await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(result.error.code).toBe("CONFLICT"); expect(f.ledger).toHaveLength(0);
    const saved = await f.saved(plan); expect(saved.payloadHash).toBe(hash); expect(saved.execution.state).toBe("failed"); expect(saved.receipts).toEqual({});
  });
  it("never hides a restricted required transition field or sends other transition fields instead", async () => {
    const f = await fixture(); f.c.accounts[0]!.restrictedUpdateFields = ["summary"];
    const result = await f.harness.invoke("transition_prepare", { account: "work", issueKey: "IK-1", expectedUpdated: f.remote.fields.updated, transitionId: "31" });
    expect(result.error.code).toBe("VALIDATION_FAILED"); expect(f.ledger).toHaveLength(0);
  });
  it("verifies unordered Jira labels after sorting without changing the plan or resending", async () => {
    const f = await fixture(); f.faults.sortLabels = true;
    const plan = await f.prepare("issue_update_prepare", { update: { labels: [{ add: "a-first" }] } });
    expect(plan.payload).toMatchObject({ expectedFields: { labels: ["read", "a-first"] } });
    const hash = planHash(plan);
    expect((await f.harness.invoke("change_apply", { proposalId: plan.id })).data.state).toBe("applied");
    expect(f.remote.fields.labels).toEqual(["a-first", "read"]);
    expect((await f.harness.invoke("change_apply", { proposalId: plan.id })).data.state).toBe("applied");
    expect(f.ledger).toHaveLength(1); expect(planHash((await f.saved(plan)).plan)).toBe(hash);
  });
  it("preserves and reviews ADF replacement without rebuilding the previous document from text", async () => {
    const f = await fixture(); const description = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "nuevo" }] }] };
    const plan = await f.prepare("issue_update_prepare", { fields: { description } });
    expect(plan.payload).toMatchObject({ previousFields: { description: f.remote.fields.description }, warnings: [expect.stringContaining("ADF")] });
    expect((await f.harness.invoke("change_apply", { proposalId: plan.id })).data.state).toBe("applied");
  });
  it("verifies a cleared ADF field returned as an empty document without changing or repeating the request", async () => {
    const f = await fixture(); f.faults.emptyDocumentOnClear = true;
    const plan = await f.prepare("issue_update_prepare", { fields: { description: null } });
    const hash = planHash(plan);
    expect(plan.payload).toMatchObject({ request: { fields: { description: null } } });
    expect((await f.harness.invoke("change_apply", { proposalId: plan.id })).data.state).toBe("applied");
    expect(f.remote.fields.description).toEqual({ type: "doc", version: 1, content: [] });
    expect((await f.harness.invoke("change_apply", { proposalId: plan.id })).data.state).toBe("applied");
    expect(f.ledger).toHaveLength(1); expect(planHash((await f.saved(plan)).plan)).toBe(hash);
  });
  it.each(["status", "project", "comment", "attachments", "worklog"])("rejects embedded capability %s, including case variations", async (field) => {
    const f = await fixture(); const result = await f.harness.invoke("issue_update_prepare", { account: "work", issueKey: "IK-1", expectedUpdated: f.remote.fields.updated, fields: { [field.toUpperCase()]: "not allowed" } });
    expect(result.error.code).toBe("VALIDATION_FAILED"); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(["readOnly", "freshness", "restricted", "unknown-field", "invalid-transition", "assignee"])("rejects incompatible preparation atomically: %s", async (cause) => {
    const f = await fixture(); let tool = "issue_update_prepare"; let extra: Record<string, unknown> = { fields: { summary: "x" } };
    if (cause === "readOnly") f.c.accounts[0]!.readOnly = true;
    if (cause === "freshness") extra.expectedUpdated = "2026-01-01T00:00:00Z";
    if (cause === "restricted") f.c.accounts[0]!.restrictedUpdateFields = ["summary"];
    if (cause === "unknown-field") extra.fields = { unknown: "x" };
    if (cause === "invalid-transition") { tool = "transition_prepare"; extra = { transitionId: "999" }; }
    if (cause === "assignee") { extra.fields = { assignee: { accountId: "other" } }; f.faults.denyAudience = true; }
    const result = await f.harness.invoke(tool, { account: "work", issueKey: "IK-1", expectedUpdated: f.remote.fields.updated, ...extra });
    expect(result.ok).toBe(false); expect(f.ledger).toHaveLength(0);
  });
});

describe("[M3][TXT/MEN/CMT][CM-02–12] protected comments", () => {
  it.each(["ticket", "internal", "public"] as const)("rejects a whitespace-only %s comment before persisting or publishing a proposal", async (audience) => {
    const f = await fixture();
    const result = await f.harness.invoke("comment_prepare", { account: "work", issueKey: "IK-1", expectedUpdated: f.remote.fields.updated, audience, text: " \t\r\n " });
    expect(result.error).toMatchObject({ code: "FORMAT_INVALID", retryable: false }); expect(f.ledger).toHaveLength(0);
    const store = new ChangeStore(f.data); try { expect(store.diagnostics().prepared).toBe(0); } finally { store.close(); }
  });
  it.each(["comment_prepare", "attachment_upload_prepare"])("classifies unknown format in %s without I/O or leaking the value", async (tool) => {
    const f = await fixture();
    const result = await f.harness.invoke(tool, { account: "work", issueKey: "IK-1", expectedUpdated: f.remote.fields.updated, audience: "public", format: "private-invalid-format-marker", ...(tool === "comment_prepare" ? { text: "x" } : { comment: "x", files: [{ path: "exports/file.txt" }] }) });
    expect(result.error).toMatchObject({ code: "FORMAT_INVALID", retryable: false });
    expect(JSON.stringify(result)).not.toContain("private-invalid-format-marker");
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.harness.assert).not.toHaveBeenCalled();
  });
  for (const scoped of [false, true]) for (const audience of destinations) for (const format of ["plain", "markdown"]) {
    it(`publishes exact ${audience}/${format}/scoped=${scoped} with validated mention identity once`, async () => {
      const f = await fixture(scoped); const text = format === "plain" ? "😀 Hola Ana\r\n*literal*" : "### Título\n\n😀 Hola **Ana**\n\n| a | b |\n|---|---|\n| c | d |";
      const start = text.indexOf("Ana");
      const plan = await f.prepare("comment_prepare", { audience, format, text, mentions: [{ start, end: start + 3, accountId: audience === "public" ? "customer" : "person" }] });
      expect(plan.mentions![0]!.displayName).toBe("Nombre validado"); expect(f.ledger).toHaveLength(0);
      const result = await f.harness.invoke("change_apply", { proposalId: plan.id });
      expect(result.ok, JSON.stringify(result)).toBe(true); expect(result.data.state).toBe("applied"); expect(result.data.notificationDelivery).toBe("unknown");
      expect(f.ledger).toHaveLength(1); const body = f.ledger[0]!.body as Record<string, unknown>; expect(body).not.toHaveProperty("format");
      if (audience !== "ticket") expect(body.public).toBe(audience === "public");
      await f.harness.invoke("change_apply", { proposalId: plan.id }); expect(f.comments.size).toBe(1);
    });
  }
  it.each(["role", "group"] as const)("keeps Platform %s visibility exact", async (type) => {
    const f = await fixture(); const visibility = { type, value: type === "role" ? "Team" : "team" };
    const plan = await f.prepare("comment_prepare", { text: "privado", audience: "ticket", visibility });
    expect((await f.harness.invoke("change_apply", { proposalId: plan.id })).data.state).toBe("applied");
    expect(plan.payload).toMatchObject({ request: { visibility } });
    expect((f.ledger[0]!.body as { visibility: unknown }).visibility).toEqual({ type, identifier: type === "group" ? "1" : "Team" });
  });
  it.each(["role", "group"] as const)("verifies Jira-resolved %s visibility without losing its restriction", async (type) => {
    const f = await fixture(); f.faults.resolvedVisibility = true;
    const visibility = { type, value: type === "role" ? "Team" : "team" };
    const plan = await f.prepare("comment_prepare", { audience: "ticket", text: "privado", visibility });
    const hash = planHash(plan);
    expect((await f.harness.invoke("change_apply", { proposalId: plan.id })).data.state).toBe("applied");
    expect((await f.harness.invoke("change_apply", { proposalId: plan.id })).data.state).toBe("applied");
    expect(f.ledger).toHaveLength(1); expect(planHash((await f.saved(plan)).plan)).toBe(hash);
  });
  it("pins the stable group identifier in the reviewed payload and outgoing comment", async () => {
    const f = await fixture();
    const plan = await f.prepare("comment_prepare", { audience: "ticket", text: "privado", visibility: { type: "group", value: "team" } });
    expect(plan.payload).toMatchObject({ request: { visibility: { type: "group", value: "team", identifier: "1" } } });
    expect((await f.harness.invoke("change_apply", { proposalId: plan.id })).data.state).toBe("applied");
    expect((f.ledger[0]!.body as { visibility: unknown }).visibility).toEqual({ type: "group", identifier: "1" });
  });
  it("blocks replacement of a group under the same name while awaiting permission", async () => {
    const f = await fixture();
    const plan = await f.prepare("comment_prepare", { audience: "ticket", text: "privado", visibility: { type: "group", value: "team" } });
    f.harness.assert.mockImplementation(async (request: unknown) => { if ((request as { action: string }).action === "jira.write") f.faults.visibilityGroupId = "different-group"; });
    const result = await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(result.error.code).toBe("CONFLICT"); expect(f.ledger).toHaveLength(0);
  });
  it("verifies Jira-resolved Platform mention labels by identity and position without republishing", async () => {
    const f = await fixture(); f.faults.resolvedMentionLabels = true;
    const plan = await f.prepare("comment_prepare", { audience: "ticket", text: "Ana y Ana", mentions: [{ start: 0, end: 3, accountId: "person" }, { start: 6, end: 9, accountId: "person" }] });
    const hash = planHash(plan);
    expect((await f.harness.invoke("change_apply", { proposalId: plan.id })).data.state).toBe("applied");
    expect((await f.harness.invoke("change_apply", { proposalId: plan.id })).data.state).toBe("applied");
    expect(f.ledger).toHaveLength(1); expect(planHash((await f.saved(plan)).plan)).toBe(hash);
  });
  it.each(["inactive", "audience", "code", "unsupported", "visibility"])("blocks invalid content/person without publication: %s", async (cause) => {
    const f = await fixture(); const input: Record<string, unknown> = { audience: "internal", text: "Ana", mentions: [{ start: 0, end: 3, accountId: "person" }] };
    if (cause === "inactive") f.faults.inactive = true;
    if (cause === "audience") f.faults.denyAudience = true;
    if (cause === "code") { input.text = "`Ana`"; input.format = "markdown"; input.mentions = [{ start: 1, end: 4, accountId: "person" }]; }
    if (cause === "unsupported") { input.text = "![x](https://example.com/image)"; input.format = "markdown"; delete input.mentions; }
    if (cause === "visibility") input.visibility = { type: "group", value: "team" };
    const result = await f.harness.invoke("comment_prepare", { account: "work", issueKey: "IK-1", expectedUpdated: f.remote.fields.updated, ...input });
    expect(result.ok).toBe(false); expect(f.ledger).toHaveLength(0);
  });
  it("returns a mention-specific error without confusing it with author or assignee authorization", async () => {
    const f = await fixture(); f.faults.inactive = true;
    const result = await f.harness.invoke("comment_prepare", { account: "work", issueKey: "IK-1", expectedUpdated: f.remote.fields.updated, audience: "ticket", text: "Ana", mentions: [{ accountId: "person", start: 0, end: 3 }] });
    expect(result.error).toMatchObject({ code: "MENTION_NOT_ALLOWED", retryable: false }); expect(f.ledger).toHaveLength(0);
  });
  it("revalidates access after preparation and never falls back from an internal note to Platform", async () => {
    const f = await fixture(); const plan = await f.prepare("comment_prepare", { audience: "internal", text: "nota" }); f.faults.denyAudience = true;
    expect((await f.harness.invoke("change_apply", { proposalId: plan.id })).ok).toBe(false); expect(f.ledger).toHaveLength(0);
  });
  it.each([false, true])("requires recognized JSM mention IDs, not matching wiki text (withAttachments=%s)", async (withAttachments) => {
    const f = await fixture(); const mention = { start: 0, end: 3, accountId: "customer" };
    const plan = withAttachments ? await f.prepare("attachment_upload_prepare", { audience: "public", files: [await f.source()], comment: "Ana", mentions: [mention] }) : await f.prepare("comment_prepare", { audience: "public", text: "Ana", mentions: [mention] });
    f.faults.mentionsMissing = true;
    const result = await f.harness.invoke("change_apply", { proposalId: plan.id }); expect(result.data.state).toBe("unknown");
    await f.harness.invoke("change_apply", { proposalId: plan.id }); expect(f.ledger).toHaveLength(withAttachments ? 2 : 1);
    f.faults.mentionsMissing = false; expect((await verifyRecorded(plan.id, f.c, { data: f.data, fetcher: f.fetcher, authorizeDownload: async () => {} })).state).toBe("applied");
  });
  it("records a rejected comment status durably without suggesting a mutation retry", async () => {
    const f = await fixture(); const plan = await f.prepare("comment_prepare", { audience: "ticket", text: "mensaje" }); f.faults.rejectAt = 1;
    const result = await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(result.data.steps[0]).toMatchObject({ state: "failed", rejectionStatus: 429, error: { code: "RATE_LIMITED", retryable: false } }); expect(f.ledger).toHaveLength(1);
  });
});

describe("[M3][ARC/UP/REC][UP-01–10][RC-05–09] pinned uploads", () => {
  it("cleans only its unassociated staging after a policy change during preparation", async () => {
    const f = await fixture(); const file = await f.source();
    f.harness.assert.mockImplementation(async (request: unknown) => { if ((request as { action: string }).action === "read") f.c.accounts[0]!.readOnly = true; });
    const result = await f.harness.invoke("attachment_upload_prepare", { account: "work", issueKey: "IK-1", expectedUpdated: f.remote.fields.updated, audience: "ticket", files: [file] });
    expect(result.ok).toBe(false); expect(await readdir(statePath(f.data))).toEqual([]); expect(f.ledger).toHaveLength(0);
  });
  it("does not delete a replacement inode even when its bytes match an unassociated copy", async () => {
    const f = await fixture(); const store = new ChangeStore(f.data);
    try {
      const path = join(store.paths.staging, "owned"); const bytes = Buffer.from("same bytes");
      await writeFile(path, bytes, { mode: 0o600 }); store.registerStagedFile("owned", await stat(path));
      await rename(path, `${path}-original`); await writeFile(path, bytes, { mode: 0o600 });
      store.discardUnassociated([{ stagedRef: "owned", publishedName: "file.txt", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }]);
      expect(await readFile(path)).toEqual(bytes);
    } finally { store.close(); }
  });
  it.each(['a"b.txt', "a[b].txt", "a|b.txt"])("rejects unsafe default publication name %s before opening a source", async (name) => {
    const f = await fixture(); const file = await f.source(name);
    const result = await f.harness.invoke("attachment_upload_prepare", { account: "work", issueKey: "IK-1", expectedUpdated: f.remote.fields.updated, audience: "public", files: [file] });
    expect(result.error.code).toBe("VALIDATION_FAILED"); expect(f.ledger).toHaveLength(0);
    expect(f.harness.assert.mock.calls.some(([request]) => (request as { action: string }).action === "read")).toBe(false);
  });
  for (const scoped of [false, true]) for (const audience of destinations) {
    it(`streams and verifies ${audience} two-file batch with fixed bytes, scoped=${scoped}`, async () => {
      const f = await fixture(scoped); const a = await f.source("vacío.txt", Buffer.alloc(0)); const b = await f.source("binario-😀.bin", Buffer.from([0, 1, 255, 13, 10]));
      const plan = await f.prepare("attachment_upload_prepare", { audience, files: [a, b], ...(audience !== "ticket" ? { comment: "Hola Ana", mentions: [{ start: 5, end: 8, accountId: audience === "public" ? "customer" : "person" }] } : {}) });
      const hash = planHash(plan); expect(f.ledger).toHaveLength(0); expect(f.temporaries.size).toBe(0);
      await writeFile(join(f.location, a.path), "cambiado");
      const result = await f.harness.invoke("change_apply", { proposalId: plan.id });
      expect(result.ok, JSON.stringify(result)).toBe(true); expect(result.data.state, JSON.stringify(result)).toBe("applied");
      expect(f.ledger).toHaveLength(audience === "ticket" ? 2 : 3); expect(f.ledger[0]!.bytes).toEqual(Buffer.alloc(0)); expect(f.ledger[1]!.bytes).toEqual(Buffer.from([0, 1, 255, 13, 10]));
      expect(f.harness.assert.mock.calls.map(([request]) => (request as { action: string }).action)).toContain("read");
      expect(f.harness.assert.mock.calls.map(([request]) => (request as { action: string }).action)).toContain("jira.download");
      await f.harness.invoke("change_apply", { proposalId: plan.id }); expect(f.ledger).toHaveLength(audience === "ticket" ? 2 : 3);
      expect(planHash((await f.saved(plan)).plan)).toBe(hash); expect(f.comments.size).toBe(audience === "ticket" ? 0 : 1);
    });
  }
  it.each(destinations)("keeps %s uploads without an additional comment separate from comment publication", async (audience) => {
    const f = await fixture(); const file = await f.source(); const plan = await f.prepare("attachment_upload_prepare", { audience, files: [file] });
    const result = await f.harness.invoke("change_apply", { proposalId: plan.id }); expect(result.data.state).toBe("applied");
    expect(f.ledger.at(-1)!.body).not.toHaveProperty("additionalComment");
  });
  it.each(["ticket", "internal", "public"] as const)("never resends a %s accepted upload whose response was lost", async (audience) => {
    const f = await fixture(); const file = await f.source(); const plan = await f.prepare("attachment_upload_prepare", { audience, files: [file] }); f.faults.disconnectAt = 1;
    const uncertain = await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(uncertain.data.state).toBe("unknown"); expect(uncertain.data.error).toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN", retryable: false });
    const saved = await verifyRecorded(plan.id, f.c, { data: f.data, fetcher: f.fetcher }); expect(saved.state).toBe("unknown");
    await f.harness.invoke("change_apply", { proposalId: plan.id }); expect(f.ledger).toHaveLength(1); expect(f.comments.size).toBe(0);
  });
  it("does not repeat temporaries or comment after uncertain JSM publication", async () => {
    const f = await fixture(); const file = await f.source(); const plan = await f.prepare("attachment_upload_prepare", { audience: "public", files: [file], comment: "una sola vez" }); f.faults.disconnectAt = 2;
    expect((await f.harness.invoke("change_apply", { proposalId: plan.id })).data.state).toBe("unknown");
    await f.harness.invoke("change_apply", { proposalId: plan.id }); expect(f.ledger).toHaveLength(2); expect(f.comments.size).toBe(1); expect((await f.saved(plan)).receipts["file-1"]!.verifiedAt).toBeDefined();
  });
  it("preserves first Platform receipt when a later file is clearly rejected", async () => {
    const f = await fixture(); const files = [await f.source("a.txt"), await f.source("b.txt")]; const plan = await f.prepare("attachment_upload_prepare", { audience: "ticket", files }); f.faults.rejectAt = 2;
    expect((await f.harness.invoke("change_apply", { proposalId: plan.id })).data.state).toBe("failed");
    expect((await f.saved(plan)).receipts["file-1"]!.verifiedAt).toBeDefined(); await f.harness.invoke("change_apply", { proposalId: plan.id }); expect(f.ledger).toHaveLength(2);
  });
  it.each(["tampered", "missing", "new-limit", "identity", "external-change", "hash"])("halts fixed upload safely at %s", async (cause) => {
    const f = await fixture(); const file = await f.source(); const plan = await f.prepare("attachment_upload_prepare", { audience: "ticket", files: [file] });
    const staged = join(statePath(f.data), plan.files[0]!.stagedRef);
    if (cause === "tampered") await writeFile(staged, "not approved");
    if (cause === "missing") await rm(staged);
    if (cause === "new-limit") f.faults.uploadLimit = 1;
    if (cause === "identity") f.faults.identity = "other";
    if (cause === "external-change") f.remote.fields.updated = "2026-11-17T23:59:00Z";
    if (cause === "hash") f.faults.wrongHash = true;
    const result = await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(result.ok && result.data.state === "applied").toBe(false); expect(f.ledger).toHaveLength(cause === "hash" ? 1 : 0);
    await f.harness.invoke("change_apply", { proposalId: plan.id }); expect(f.ledger).toHaveLength(cause === "hash" ? 1 : 0);
  });
  it("verifies a stored upload receipt by authorized reads only after a failed download permission", async () => {
    const f = await fixture(); const file = await f.source(); const plan = await f.prepare("attachment_upload_prepare", { audience: "ticket", files: [file] });
    f.harness.assert.mockImplementation(async (request: unknown) => { if ((request as { action: string }).action === "jira.download") throw new Error("native download denied"); });
    await expect(f.harness.invoke("change_apply", { proposalId: plan.id })).rejects.toThrow("native download denied");
    const authorizeDownload = vi.fn(async () => {});
    expect((await verifyRecorded(plan.id, f.c, { data: f.data, fetcher: f.fetcher, authorizeDownload })).state).toBe("applied");
    expect(authorizeDownload).toHaveBeenCalledTimes(1); expect(f.ledger).toHaveLength(1);
  });
  it.each(destinations)("continues only verified pending %s steps after a persisted interruption, with a new permission", async (audience) => {
    const f = await fixture(); const files = [await f.source("a.txt"), await f.source("b.txt")]; const plan = await f.prepare("attachment_upload_prepare", { audience, files }); const hash = planHash(plan);
    f.faults.blockAfter = 1;
    const interrupted = await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(interrupted.error.code).toBe("WRITE_OUTCOME_UNKNOWN"); const progress = await f.saved(plan);
    expect(progress.execution.state).toBe("unknown"); expect(progress.receipts["file-1"]!.verifiedAt).toBeDefined(); expect(progress.execution.steps[1]!.state).toBe("pending");
    f.faults.blockAfter = 0;
    const result = await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(result.data.state, JSON.stringify(result)).toBe("applied"); expect(f.ledger).toHaveLength(audience === "ticket" ? 2 : 3);
    expect(f.harness.assert.mock.calls.filter(([request]) => (request as { action: string }).action === "jira.write")).toHaveLength(2); expect(planHash((await f.saved(plan)).plan)).toBe(hash);
  });
  it("does not mistake external drift for the first upload's own updated timestamp", async () => {
    const f = await fixture(); const files = [await f.source("a.txt"), await f.source("b.txt")]; const plan = await f.prepare("attachment_upload_prepare", { audience: "ticket", files }); f.faults.blockAfter = 1;
    await f.harness.invoke("change_apply", { proposalId: plan.id }); f.faults.blockAfter = 0; f.remote.fields.updated = "2026-11-17T23:59:00Z";
    expect((await f.harness.invoke("change_apply", { proposalId: plan.id })).ok).toBe(false); expect(f.ledger).toHaveLength(1);
  });
  it.each(["incompleteHistory", "foreignHistory"] as const)("does not absorb unrelated or unproven updates: %s", async (fault) => {
    const f = await fixture(); const plan = await f.prepare("attachment_upload_prepare", { audience: "ticket", files: [await f.source("a.txt"), await f.source("b.txt")] }); f.faults[fault] = true;
    const result = await f.harness.invoke("change_apply", { proposalId: plan.id }); expect(result.data.state).toBe("unknown"); expect(f.ledger).toHaveLength(1);
  });
  it("checks the session again after download authorization before receiving binary content", async () => {
    const f = await fixture(); const plan = await f.prepare("attachment_upload_prepare", { audience: "ticket", files: [await f.source()] });
    f.harness.assert.mockImplementation(async (request: unknown) => { if ((request as { action: string }).action === "jira.download") f.harness.session.mockResolvedValue({ id: "other-session", location: { directory: f.location } }); });
    expect((await f.harness.invoke("change_apply", { proposalId: plan.id })).error.code).toBe("WRITE_OUTCOME_UNKNOWN");
    expect(f.fetcher.mock.calls.some(([url]) => String(url).includes("/attachment/content/"))).toBe(false); expect(f.ledger).toHaveLength(1);
  });
  it("cancels a stalled verification stream while preserving the confirmed mutation", async () => {
    const f = await fixture(); const plan = await f.prepare("attachment_upload_prepare", { audience: "ticket", files: [await f.source()] });
    const controller = new AbortController(); const reason = new Error("native cancellation"); const cancel = vi.fn(); const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      if (String(url).includes("/attachment/content/")) { setImmediate(() => controller.abort(reason)); return new Response(new ReadableStream({ cancel })); }
      return original(url, init);
    });
    await expect(f.harness.invoke("change_apply", { proposalId: plan.id }, controller.signal)).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalled(); const saved = await f.saved(plan); expect(saved.execution.state).toBe("unknown"); expect(saved.receipts["file-1"]).toBeDefined(); expect(f.ledger).toHaveLength(1);
  });
  it.each(["ticket", "internal", "public"] as const)("never transmits %s uploads when native write permission is refused", async (audience) => {
    const f = await fixture(); const plan = await f.prepare("attachment_upload_prepare", { audience, files: [await f.source()] });
    f.harness.assert.mockImplementation(async (request: unknown) => { if ((request as { action: string }).action === "jira.write") throw new Error("native refusal"); });
    await expect(f.harness.invoke("change_apply", { proposalId: plan.id })).rejects.toThrow("native refusal"); expect(f.ledger).toHaveLength(0); expect(f.temporaries.size).toBe(0);
  });
  it("does not equate allow with full review of an upload", async () => {
    const f = await fixture(); const plan = await f.prepare("attachment_upload_prepare", { audience: "public", files: [await f.source()] }, false);
    const result = await f.harness.invoke("change_apply", { proposalId: plan.id }); expect(result.error.code).toBe("FORBIDDEN"); expect(result.account).toBe("work"); expect(f.ledger).toHaveLength(0);
    expect(f.harness.assert.mock.calls.some(([request]) => (request as { action: string }).action === "jira.write")).toBe(false);
  });
});
function statePath(data: string) { return join(data, "runtime", "staging"); }
