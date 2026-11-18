import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/http.js";
import { captureCredential } from "../../src/credentials.js";
import { MutationUncertainError } from "../../src/jira/mutations.js";
import { config, json, mockFetch, signal } from "../helpers.js";

const roots: string[] = [];
beforeEach(() => vi.stubEnv("IK_TEST_WORK", "synthetic-token"));
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });
async function fixture(bytes = Buffer.from("binario\0\xff")) {
  const staging = await mkdtemp("/tmp/opencode/jira-multipart-"); roots.push(staging);
  const path = join(staging, "pinned"); await writeFile(path, bytes, { mode: 0o600 });
  const file = { stagedRef: "pinned", publishedName: "informe-ñ.bin", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const c = config(true); c.accounts[0]!.readOnly = false; c.attachments.enabled = true;
  const account = c.accounts[0]!; const credential = await captureCredential(account, async () => "person");
  return { staging, path, file, c, account, credential, bytes };
}
describe("[HTTP-03][UP-04–UP-09][RC-01/02] pinned bounded multipart", () => {
  it.each([0, 200000])("streams %i pinned bytes with a generated boundary and one file part", async (size) => {
    const f = await fixture(Buffer.alloc(size, 0xab)); let journaled = false;
    const fetcher = mockFetch(async (url, init) => {
      expect(journaled).toBe(true); expect(url.pathname).toBe("/rest/api/3/issue/IK-1/attachments"); expect(init.redirect).toBe("manual");
      const headers = init.headers as Record<string, string>; expect(headers["X-Atlassian-Token"]).toBe("no-check"); expect(headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=issuekeeper-/);
      const reader = (init.body as ReadableStream<Uint8Array>).getReader(); const chunks: Buffer[] = [];
      for (;;) { const { done, value } = await reader.read(); if (done) break; expect(value.length).toBeLessThanOrEqual(65536); chunks.push(Buffer.from(value)); }
      const body = Buffer.concat(chunks); expect(body.length).toBe(Number(headers["Content-Length"])); expect(body.includes(f.bytes)).toBe(true);
      expect(body.toString("utf8")).toContain('name="file"; filename="informe-ñ.bin"'); return json([{ id: "1" }]);
    });
    const http = new HttpClient(f.c, fetcher);
    await expect(http.upload(f.account, { kind: "platform", issueKey: "IK-1" }, f.staging, f.file, f.credential, signal(), async () => { journaled = true; })).resolves.toMatchObject({ outcome: "confirmed", status: 200 });
    expect(fetcher).toHaveBeenCalledTimes(1); http.close();
  });
  it("uses only the fixed JSM temporary endpoint and expects 201", async () => {
    const f = await fixture(); const fetcher = mockFetch(async (url, init) => { expect(url.pathname).toBe("/rest/servicedeskapi/servicedesk/2/attachTemporaryFile"); await new Response(init.body).arrayBuffer(); return json({ temporaryAttachments: [{ temporaryAttachmentId: "temp1" }] }, 201); });
    const http = new HttpClient(f.c, fetcher);
    await expect(http.upload(f.account, { kind: "jsm-temporary", serviceDeskId: "2" }, f.staging, f.file, f.credential, signal(), async () => {})).resolves.toMatchObject({ outcome: "confirmed", status: 201 }); http.close();
  });
  it.each(["modified", "missing", "symlink", "hash", "name"])("does not journal or send %s staging", async (kind) => {
    const f = await fixture(); const fetcher = mockFetch(() => json([])); const journal = vi.fn(async () => {});
    if (kind === "modified") await writeFile(f.path, "changed");
    if (kind === "missing" || kind === "symlink") await rm(f.path);
    if (kind === "symlink") await symlink("/dev/null", f.path);
    if (kind === "hash") f.file.sha256 = "a".repeat(64);
    if (kind === "name") f.file.publishedName = 'header"injection';
    const http = new HttpClient(f.c, fetcher);
    await expect(http.upload(f.account, { kind: "platform", issueKey: "IK-1" }, f.staging, f.file, f.credential, signal(), journal)).rejects.toBeInstanceOf(Error);
    expect(journal).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); http.close();
  });
  it.each([429, 503])("never retries HTTP %i during upload", async (status) => {
    const f = await fixture(); const fetcher = mockFetch(async (_url, init) => { await new Response(init.body).arrayBuffer(); return json({}, status); }); const http = new HttpClient(f.c, fetcher);
    const uploading = http.upload(f.account, { kind: "platform", issueKey: "IK-1" }, f.staging, f.file, f.credential, signal(), async () => {});
    if (status === 429) await expect(uploading).resolves.toMatchObject({ outcome: "rejected" }); else await expect(uploading).rejects.toBeInstanceOf(MutationUncertainError);
    expect(fetcher).toHaveBeenCalledTimes(1); http.close();
  });
  it("does not switch to a substituted inode after pin verification", async () => {
    const f = await fixture(); const fetcher = mockFetch(async (_url, init) => { const body = Buffer.from(await new Response(init.body).arrayBuffer()); expect(body.includes(f.bytes)).toBe(true); expect(body.includes(Buffer.from("substitute"))).toBe(false); return json([{ id: "1" }]); });
    const http = new HttpClient(f.c, fetcher);
    await expect(http.upload(f.account, { kind: "platform", issueKey: "IK-1" }, f.staging, f.file, f.credential, signal(), async () => { await rm(f.path); await writeFile(f.path, "substitute", { mode: 0o600 }); })).resolves.toMatchObject({ outcome: "confirmed" }); http.close();
  });
  it("keeps corruption after dispatch uncertain and does not send a second stream", async () => {
    const f = await fixture(); const fetcher = mockFetch(async (_url, init) => { await new Response(init.body).arrayBuffer(); return json([]); }); const http = new HttpClient(f.c, fetcher);
    await expect(http.upload(f.account, { kind: "platform", issueKey: "IK-1" }, f.staging, f.file, f.credential, signal(), async () => { await writeFile(f.path, Buffer.alloc(f.file.size, 65)); })).rejects.toBeInstanceOf(MutationUncertainError);
    expect(fetcher).toHaveBeenCalledTimes(1); http.close();
  });
});
