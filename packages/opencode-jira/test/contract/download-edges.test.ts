import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, open } from "node:fs/promises";
import { join } from "node:path";
import { planDownload, saveDownload } from "../../src/files.js";
import { config, createService, issue, json, mockFetch, attachment, signal } from "../helpers.js";
import { toolHarness } from "../harness.js";

let root: string;
beforeEach(async () => { root = await mkdtemp("/tmp/opencode/ik-download-edge-"); vi.stubEnv("IK_TEST_WORK", "secret"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
describe("[5.10][E13][DE-02] binary integrity", () => {
  it.each([new Uint8Array(0), new Uint8Array([0, 255, 128, 10, 0, 254]), new Uint8Array(2048).fill(255), new Uint8Array(randomBytes(1024))])("retains exact bytes and SHA-256 (%#)", async (bytes) => {
    const plan = planDownload(join(root, ".issuekeeper/downloads"), "binary.dat", "101");
    const result = await saveDownload(new Response(bytes), plan, root, bytes.length, 2048, signal());
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await readFile(join(root, result.path))).toEqual(Buffer.from(bytes));
    expect(await readdir(plan.directory)).toEqual([plan.filename]);
  });
  it.each(["ENOSPC", "EIO"])("cleans temporary files on write error %s", async (code) => {
    const probe = await open(join(root, "probe"), "wx", 0o600);
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const write = vi.spyOn(prototype, "write").mockRejectedValueOnce(Object.assign(new Error("filesystem failure"), { code }));
    const directory = join(root, ".issuekeeper/downloads");
    try {
      await expect(saveDownload(new Response("hello"), planDownload(directory, "file", "101"), root, 5, 5, signal())).rejects.toMatchObject({ code: "TRANSFER_INCOMPLETE" });
      expect(await readdir(directory)).toEqual([]);
    } finally { write.mockRestore(); }
  });
  it("excludes concurrent publication to the same destination without leaving temporaries", async () => {
    const directory = join(root, ".issuekeeper/downloads");
    const results = await Promise.allSettled([1, 2].map(() => saveDownload(new Response("hello"), planDownload(directory, "file", "101"), root, 5, 5, signal())));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await readdir(directory)).toEqual(["101-file"]);
    expect(await readFile(join(directory, "101-file"), "utf8")).toBe("hello");
  });
  it("propagates native cancellation and cleans its temporary", async () => {
    const directory = join(root, ".issuekeeper/downloads");
    const controller = new AbortController(); const reason = new Error("cancel download");
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array([1])); },
      pull() { setTimeout(() => controller.abort(reason), 10); },
    });
    await expect(saveDownload(new Response(body), planDownload(directory, "file", "101"), root, 5, 5, controller.signal)).rejects.toBe(reason);
    expect(await readdir(directory).catch(() => [])).toEqual([]);
  });
  it("refuses a directory moved during streaming without publishing a final file", async () => {
    const directory = join(root, "downloads");
    await mkdir(directory, { mode: 0o700 });
    let move: Promise<void> | undefined;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        move ??= rename(directory, join(root, "moved"));
        await move; c.enqueue(new Uint8Array([1])); c.close();
      },
    }, { highWaterMark: 0 });
    await expect(saveDownload(new Response(body), planDownload(directory, "file", "101"), root, 1, 5, signal())).rejects.toBeDefined();
    await move;
    expect(await readdir(join(root, "moved"))).toEqual([]);
  });
  it("[DE-08] revalidates location after approval, before content or local writes", async () => {
    const fetcher = mockFetch((url) => url.pathname === "/rest/api/3/attachment/101" ? json(attachment)
      : url.searchParams.get("fields") === "attachment,project" ? json({ id: "10001", fields: { project: issue().fields.project, attachment: [attachment] } }) : json(issue()));
    const service = await createService(config(), root, fetcher);
    try {
      const h = await toolHarness(service);
      h.assert.mockImplementation(async (permission) => {
        if ((permission as { action: string }).action === "edit") h.session.mockResolvedValue({ location: { directory: "/tmp/opencode" } });
      });
      const result = await h.invoke("attachment_download", { account: "work", issueKey: "IK-1", attachmentId: "101" });
      expect(result.error.code).toBe("FILE_ACCESS_DENIED");
      const edit = h.assert.mock.calls.map(([p]) => p as any).find((p) => p.action === "edit");
      expect(edit.resources[0]).toBe(".issuekeeper/downloads/101-example.txt");
      expect(edit.save).toEqual([".issuekeeper/downloads/101-example.txt"]);
      expect(fetcher.mock.calls.some(([url]) => String(url).includes("/attachment/content/"))).toBe(false);
      expect(await readdir(root)).toEqual([]);
    } finally { service.close(); }
  });
  it("[ADJ-02] verifies metadata after membership and before bytes", async () => {
    const fetcher = mockFetch((url) => url.pathname === "/rest/api/3/attachment/101" ? json({ ...attachment, size: 6 })
      : url.searchParams.get("fields") === "attachment,project" ? json({ id: "10001", fields: { project: issue().fields.project, attachment: [attachment] } }) : json(issue()));
    const service = await createService(config(), root, fetcher);
    try {
      await expect(service.download({ account: "work", issueKey: "IK-1", attachmentId: "101" }, signal(), { read: async () => {}, local: async () => {} })).rejects.toMatchObject({ code: "TRANSFER_INCOMPLETE" });
      expect(fetcher.mock.calls.some(([url]) => String(url).includes("/attachment/content/"))).toBe(false);
      expect(await readdir(root)).toEqual([]);
    } finally { service.close(); }
  });
});
