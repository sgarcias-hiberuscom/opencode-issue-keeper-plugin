import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { saveDownload, planDownload } from "../../src/files.js";
import { createService, attachment, config, issue, json, mockFetch, request, signal } from "../helpers.js";

let location: string;
beforeEach(async () => { vi.stubEnv("IK_TEST_WORK", "work-secret"); location = await mkdtemp("/tmp/opencode/ik-download-"); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(location, { recursive: true }); });

function platformFetch(binary: () => Response = () => new Response("hello")) {
  return mockFetch((url) => {
    if (url.pathname.includes("/attachment/content/")) { expect(url.searchParams.get("redirect")).toBe("false"); return binary(); }
    if (url.pathname === "/rest/api/3/attachment/101") return json(attachment);
    if (url.searchParams.get("fields") === "attachment,project") return json({ id: "10001", fields: { project: issue().fields.project, attachment: [attachment] } });
    return json(issue());
  });
}
const input = { account: "work", issueKey: "IK-1", attachmentId: "101" };
const access = () => ({ read: vi.fn(async () => {}), local: vi.fn(async () => {}) });

describe("protected binary download", () => {
  it("checks membership and local authorization, streams bytes and returns a server receipt", async () => {
    const fetcher = platformFetch(); const service = await createService(config(), location, fetcher); const permissions = access();
    try {
      const receipt = await service.download(input, signal(), permissions);
      expect(permissions.local).toHaveBeenCalledTimes(1);
      expect(receipt.data).toMatchObject({ path: ".issuekeeper/downloads/101-example.txt", account: "work", issueKey: "IK-1", size: 5, location: "server", sha256: createHash("sha256").update("hello").digest("hex") });
      expect(await readFile(join(location, receipt.data.path), "utf8")).toBe("hello");
      expect(await readdir(join(location, ".issuekeeper/downloads"))).toEqual(["101-example.txt"]);
      expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    } finally { service.close(); }
  });
  it("does not overwrite an existing destination", async () => {
    const service = await createService(config(), location, platformFetch());
    try {
      const first = await service.download(input, signal(), access());
      await expect(service.download(input, signal(), access())).rejects.toMatchObject({ code: "FILE_ACCESS_DENIED" });
      expect(await readFile(join(location, first.data.path), "utf8")).toBe("hello");
      expect(await readdir(join(location, ".issuekeeper/downloads"))).toEqual(["101-example.txt"]);
    } finally { service.close(); }
  });
  it("propagates a native denial before transferring bytes or creating a directory", async () => {
    const fetcher = platformFetch(); const service = await createService(config(), location, fetcher); const denial = new Error("OpenCode permission rejected");
    try {
      const permissions = access(); permissions.local.mockRejectedValue(denial);
      await expect(service.download(input, signal(), permissions)).rejects.toBe(denial);
      expect(fetcher.mock.calls.some(([url]) => String(url).includes("attachment/content"))).toBe(false);
      expect(await readdir(location)).toEqual([]);
    } finally { service.close(); }
  });
  it("does not retrieve a global ID absent from the ticket", async () => {
    const fetcher = platformFetch(); const service = await createService(config(), location, fetcher);
    try {
      await expect(service.download({ ...input, attachmentId: "999" }, signal(), access())).rejects.toMatchObject({ code: "NOT_FOUND_OR_NO_ACCESS" });
      expect(fetcher.mock.calls.some(([url]) => String(url).includes("attachment/content"))).toBe(false);
    } finally { service.close(); }
  });
  it.each([
    [() => new Response("hel"), "TRANSFER_INCOMPLETE"],
    [() => new Response("hello extra"), "TRANSFER_INCOMPLETE"],
    [() => new Response("hello", { headers: { "content-length": "999999999" } }), "ATTACHMENT_TOO_LARGE"],
    [() => new Response(null, { status: 303, headers: { location: "https://media.example.com/signed" } }), "REDIRECT_NOT_ALLOWED"],
    [() => new Response(new ReadableStream({ start(controller) { controller.error(new Error("network broke")); } })), "TRANSFER_INCOMPLETE"],
  ])("fails incomplete/oversized/redirected transfers and leaves no final file (%#)", async (binary, code) => {
    const service = await createService(config(), location, platformFetch(binary));
    try {
      await expect(service.download(input, signal(), access())).rejects.toMatchObject({ code });
      const files = await readdir(join(location, ".issuekeeper/downloads")).catch(() => []);
      expect(files).toEqual([]);
    } finally { service.close(); }
  });
  it("refuses symlink directories and destination symlinks", async () => {
    const service = await createService(config(), location, platformFetch());
    try {
      await mkdir(join(location, "elsewhere"), { mode: 0o700 });
      await symlink(join(location, "elsewhere"), join(location, ".issuekeeper"));
      await expect(service.download(input, signal(), access())).rejects.toMatchObject({ code: "FILE_ACCESS_DENIED" });
      expect(await readdir(join(location, "elsewhere"))).toEqual([]);
      await rm(join(location, ".issuekeeper"));
      await mkdir(join(location, ".issuekeeper/downloads"), { recursive: true, mode: 0o700 });
      const secret = join(location, "elsewhere/secret"); await writeFile(secret, "not-overwritten");
      await symlink(secret, join(location, ".issuekeeper/downloads/101-example.txt"));
      await expect(service.download(input, signal(), access())).rejects.toMatchObject({ code: "FILE_ACCESS_DENIED" });
      expect(await readFile(secret, "utf8")).toBe("not-overwritten");
    } finally { service.close(); }
  });
  it("sanitizes remote names and enforces actual streamed bytes", async () => {
    const directory = join(location, ".issuekeeper/downloads");
    const plan = planDownload(directory, "../../secret/../evil.txt", "101");
    expect(plan.filename).not.toContain("/");
    await expect(saveDownload(new Response("123456"), plan, location, 6, 5, signal())).rejects.toMatchObject({ code: "ATTACHMENT_TOO_LARGE" });
    await expect(saveDownload(new Response("123456"), plan, location, 5, 5, signal())).rejects.toMatchObject({ code: "ATTACHMENT_TOO_LARGE" });
    expect(await readdir(directory)).toEqual([]);
  });
  it("refuses a location that another user could rewrite", async () => {
    await chmod(location, 0o777);
    const service = await createService(config(), location, platformFetch());
    try {
      await expect(service.download(input, signal(), access())).rejects.toMatchObject({ code: "FILE_ACCESS_DENIED" });
      expect(await readdir(location)).toEqual([]);
    } finally { service.close(); }
  });
  it("uses JSM listing and download endpoints without a Platform content fallback", async () => {
    const c = config(true); const fetcher = mockFetch((url) => {
      if (url.pathname.endsWith("/attachment/101")) return new Response("hello");
      if (url.pathname.endsWith("/attachment")) return json({ start: 0, limit: 100, size: 1, isLastPage: true, values: [{ ...attachment, id: undefined, _links: { jiraRest: "https://example.atlassian.net/rest/api/2/attachment/101" } }] });
      if (url.pathname.includes("/api/3/issue/")) return json(issue());
      return json(request());
    });
    const service = await createService(c, location, fetcher);
    try {
      expect((await service.download(input, signal(), access())).data.size).toBe(5);
      expect(fetcher.mock.calls.some(([url]) => String(url).includes("attachment/content"))).toBe(false);
    } finally { service.close(); }
  });
  it("aborts stalled binary streaming and removes only its own temporary", async () => {
    const c = config(); c.attachments.transferTimeoutMs = 30;
    const cancelled = vi.fn();
    const service = await createService(c, location, platformFetch(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("he")); }, cancel: cancelled,
    }))));
    try {
      await expect(service.download(input, signal(), access())).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(await readdir(join(location, ".issuekeeper/downloads")).catch(() => [])).toEqual([]);
    } finally { service.close(); }
  });
});
