import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { parseConfig, within, type Config } from "../../src/config.js";
import { HttpClient } from "../../src/http.js";
import { JiraCloud } from "../../src/jira/cloud.js";
import { Service } from "../../src/core/service.js";
import { toolHarness } from "../harness.js";

const live = process.env.ISSUEKEEPER_LIVE_READS === "1";
const Inventory = z.strictObject({
  cases: z.array(z.strictObject({
    account: z.string(), issueKey: z.string(), issueId: z.string(), identityId: z.string(),
    jql: z.string(), expectedSearchKeys: z.array(z.string()).min(1),
    mentionQuery: z.string(), mentionIds: z.array(z.string()).min(1),
    ambiguous: z.boolean().optional(), excludedMentionIds: z.array(z.string()).optional(),
    audience: z.enum(["ticket", "internal", "public"]),
    commentIds: z.array(z.string()),
    forbiddenIssueKey: z.string().optional(),
    attachments: z.array(z.strictObject({ id: z.string(), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
  })).min(2).max(10),
});
type Inventory = z.infer<typeof Inventory>;
let root: string;
let service: Service;
let h: Awaited<ReturnType<typeof toolHarness>>;
let config: Config;
let inventory: Inventory;

async function externalJson(path: string | undefined) {
  if (!path || !isAbsolute(path)) throw new Error("Configure rutas absolutas privadas para configuración e inventario.");
  const canonical = await realpath(path);
  const repository = await realpath(new URL("../../../../", import.meta.url));
  if (within(repository, canonical)) throw new Error("El inventario y la configuración reales deben estar fuera del repositorio.");
  return JSON.parse(await readFile(canonical, "utf8")) as unknown;
}
describe.skipIf(!live)("[10.3][E01][E02][E03][E04][E13] authorized real inventory", () => {
  beforeAll(async () => {
    config = parseConfig(await externalJson(process.env.ISSUEKEEPER_LIVE_CONFIG));
    const parsed = Inventory.safeParse(await externalJson(process.env.ISSUEKEEPER_LIVE_INVENTORY));
    if (!parsed.success) throw new Error("Inventario real inválido; revise el contrato sin publicar sus datos.");
    inventory = parsed.data;
    root = await mkdtemp("/tmp/opencode/issuekeeper-live-");
    service = await Service.create(config, root, new JiraCloud(config, new HttpClient(config)));
    h = await toolHarness(service);
  });
  afterAll(async () => { service?.close(); if (root) await rm(root, { recursive: true, force: true }); });
  it("confirms two sites, both authentication modes and known identities through registered tools", async () => {
    expect(new Set(config.accounts.map((a) => a.siteUrl)).size >= 2).toBe(true);
    expect(new Set(config.accounts.map((a) => a.auth.mode)).size === 2).toBe(true);
    for (const fixture of inventory.cases) {
      const result = await h.invoke("connection_test", { account: fixture.account });
      expect(result.ok === true && result.data.identity.id === fixture.identityId).toBe(true);
      const ticket = await h.invoke("issue_get", { account: fixture.account, issueKey: fixture.issueKey });
      expect(ticket.ok === true && ticket.data.id === fixture.issueId).toBe(true);
    }
    expect(h.assert.mock.calls.length > 0).toBe(true);
  }, 120000);
  it("confirms inventory keys and finishes search pagination without inventing a total", async () => {
    for (const fixture of inventory.cases) {
      const keys = new Set<string>();
      let cursor: string | undefined;
      let last = false;
      for (let page = 0; page < 100; page++) {
        const result = await h.invoke("issues_search", { account: fixture.account, jql: fixture.jql, maxResults: 100, cursor });
        expect(result.ok === true).toBe(true);
        result.data.values.forEach((ticket: { key: string }) => keys.add(ticket.key));
        cursor = result.data.cursor; last = result.data.isLast;
        if (page === 0 && cursor) {
          const other = inventory.cases.find((item) => item.account !== fixture.account);
          if (other) {
            const mismatch = await h.invoke("issues_search", { account: other.account, jql: fixture.jql, maxResults: 100, cursor });
            expect(mismatch.ok === false && mismatch.error.code === "CURSOR_INVALID").toBe(true);
          }
        }
        if (last) break;
      }
      expect(last).toBe(true);
      expect(fixture.expectedSearchKeys.every((key) => keys.has(key))).toBe(true);
    }
  }, 240000);
  it("confirms visible comment IDs, contextual candidates and configured restrictions", async () => {
    for (const fixture of inventory.cases) {
      const commentIds = new Set<string>();
      let cursor: string | undefined;
      let last = false;
      for (let page = 0; page < 100; page++) {
        const result = await h.invoke("comments_list", { account: fixture.account, issueKey: fixture.issueKey, audience: fixture.audience, maxResults: 100, cursor });
        expect(result.ok === true).toBe(true);
        result.data.values.forEach((comment: { id: string }) => commentIds.add(comment.id));
        cursor = result.data.cursor; last = result.data.isLast;
        if (last) break;
      }
      expect(last && fixture.commentIds.every((id) => commentIds.has(id))).toBe(true);
      const ids = new Set<string>(); cursor = undefined; last = false;
      let ambiguous = false;
      for (let page = 0; page < 100; page++) {
        const result = await h.invoke("mention_candidates", { account: fixture.account, issueKey: fixture.issueKey, audience: fixture.audience, query: fixture.mentionQuery, maxResults: 100, cursor });
        expect(result.ok === true).toBe(true);
        result.data.values.forEach((candidate: { accountId: string }) => ids.add(candidate.accountId));
        ambiguous ||= result.data.ambiguous === true;
        cursor = result.data.cursor; last = result.data.isLast;
        if (last) break;
      }
      expect(last && fixture.mentionIds.every((id) => ids.has(id))).toBe(true);
      if (fixture.ambiguous !== undefined) expect(ambiguous === fixture.ambiguous).toBe(true);
      expect((fixture.excludedMentionIds ?? []).every((id) => !ids.has(id))).toBe(true);
      if (fixture.forbiddenIssueKey) {
        const result = await h.invoke("issue_get", { account: fixture.account, issueKey: fixture.forbiddenIssueKey });
        expect(result.ok === false && result.error.code === "FORBIDDEN").toBe(true);
      }
    }
  }, 240000);
  it.skipIf(process.env.ISSUEKEEPER_LIVE_DOWNLOADS !== "1")("checks known empty/binary download sizes and hashes in an isolated location", async () => {
    let index = 0;
    const receipts: unknown[] = [];
    for (const fixture of inventory.cases) for (const attachment of fixture.attachments) {
      const result = await h.invoke("attachment_download", {
        account: fixture.account, issueKey: fixture.issueKey, attachmentId: attachment.id, destinationName: `inventory-${++index}.bin`,
      });
      expect(result.ok === true && result.data.size === attachment.size && result.data.sha256 === attachment.sha256).toBe(true);
      receipts.push({
        requestId: result.meta.requestId, account: fixture.account, issueKey: fixture.issueKey,
        attachmentId: attachment.id, size: result.data.size, sha256: result.data.sha256,
        via: result.data.via, audience: result.data.audience, path: result.data.path, location: "server",
      });
    }
    expect(index > 0).toBe(true);
    await mkdir("reports/live", { recursive: true, mode: 0o700 });
    await writeFile("reports/live/receipts.json", `${JSON.stringify(receipts, null, 2)}\n`, { mode: 0o600 });
  }, 300000);
});
