import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { config, json, mockFetch, signal } from "../helpers.js";
import { HttpClient } from "../../src/http.js";

let server: Server | undefined;
beforeEach(() => { vi.stubEnv("IK_TEST_WORK", "secret"); vi.stubEnv("IK_TEST_CLIENT", "other"); });
afterEach(async () => { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; vi.unstubAllEnvs(); });
describe("[6.4][E01][HT-06] transport edges", () => {
  const mediaPath = "/file/11111111-2222-4333-8444-555555555555/binary";
  const binaryPath = "rest/api/3/attachment/content/101?redirect=false";
  it("negotiates arbitrary binary MIME types and follows one credential-free media hop", async () => {
    const c = config();
    const fetcher = mockFetch((url, init) => {
      expect(new Headers(init.headers).get("accept")).toBe("*/*");
      if (url.hostname === "api.media.atlassian.com") {
        expect(new Headers(init.headers).has("authorization")).toBe(false);
        expect(new Headers(init.headers).has("cookie")).toBe(false);
        expect(init.credentials).toBe("omit");
        expect(init.redirect).toBe("manual");
        return new Response("hello", { headers: { "content-type": "text/plain" } });
      }
      expect(new Headers(init.headers).has("authorization")).toBe(true);
      return new Response(null, { status: 303, headers: { location: `https://api.media.atlassian.com${mediaPath}?token=synthetic` } });
    });
    const http = new HttpClient(c, fetcher);
    try {
      expect(await http.read(c.accounts[0]!, binaryPath, signal(), async r => r.text(), undefined, true)).toBe("hello");
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { http.close(); }
  });
  it.each([
    "not a URL", "http://api.media.atlassian.com", "https://127.0.0.1", "https://api.media.atlassian.com.evil.invalid",
    "https://api.media.atlassian.com:444", "https://user:password@api.media.atlassian.com",
    "https://api.media.atlassian.com/other", `https://api.media.atlassian.com${mediaPath}#fragment`,
  ])("rejects an unvalidated binary location without visiting or disclosing it: %s", async location => {
    const c = config();
    const fetcher = mockFetch(() => new Response(null, { status: 303, headers: { location } }));
    const http = new HttpClient(c, fetcher);
    try {
      const error = await http.read(c.accounts[0]!, binaryPath, signal(), async r => r.text(), undefined, true).catch(e => e);
      expect(error.code).toBe("REDIRECT_NOT_ALLOWED");
      expect(error.message).not.toContain(location);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { http.close(); }
  });
  it("bounds binary redirects to one hop and never visits a second media location", async () => {
    const c = config();
    const fetcher = mockFetch(() => new Response(null, { status: 303, headers: { location: `https://api.media.atlassian.com${mediaPath}?token=synthetic` } }));
    const http = new HttpClient(c, fetcher);
    try {
      await expect(http.read(c.accounts[0]!, binaryPath, signal(), async r => r.text(), undefined, true)).rejects.toMatchObject({ code: "REDIRECT_NOT_ALLOWED" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { http.close(); }
  });
  it("rejects redirects with real fetch, without retry or visiting Location", async () => {
    let source = 0; let destination = 0;
    server = createServer((req, res) => {
      if (req.url === "/destination") { destination++; res.end("{}"); return; }
      source++; res.writeHead(302, { location: "/destination" }); res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const fetcher = mockFetch((_, init) => fetch(`http://127.0.0.1:${port}/source`, init));
    const c = config(); const http = new HttpClient(c, fetcher);
    try {
      await expect(http.json(c.accounts[0]!, "rest/api/3/myself", signal())).rejects.toMatchObject({ code: "REDIRECT_NOT_ALLOWED", retryable: false });
      expect(source).toBe(1); expect(destination).toBe(0);
    } finally { http.close(); }
  });
  it.each([500, 502, 503, 504, 429])("bounds retries for transient HTTP %i", async (status) => {
    const c = config(); c.http.readMaxAttempts = 2;
    const fetcher = mockFetch(() => json({}, status, { "retry-after": "0" }));
    const http = new HttpClient(c, fetcher);
    try {
      await expect(http.json(c.accounts[0]!, "rest/api/3/myself", signal())).rejects.toMatchObject({ retryable: true });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { http.close(); }
  });
  it("does not occupy alias/site permits during backoff", async () => {
    const c = config(); c.http.maxConcurrentPerAccount = 1;
    const order: string[] = [];
    let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    const fetcher = mockFetch((url) => {
      if (url.pathname.endsWith("/myself") && !order.includes("first")) { order.push("first"); started(); return json({}, 503); }
      order.push(url.pathname.endsWith("/myself") ? "retry" : "other");
      return json({});
    });
    const http = new HttpClient(c, fetcher);
    try {
      const first = http.json(c.accounts[0]!, "rest/api/3/myself", signal());
      await ready;
      await http.json(c.accounts[0]!, "rest/api/3/attachment/101", signal());
      await first;
      expect(order).toEqual(["first", "other", "retry"]);
    } finally { http.close(); }
  });
  it("propagates the native signal reason during backoff without retry", async () => {
    const c = config();
    let received!: () => void; const ready = new Promise<void>((resolve) => { received = resolve; });
    const fetcher = mockFetch(() => { received(); return json({}, 503); });
    const http = new HttpClient(c, fetcher);
    try {
      const controller = new AbortController(); const reason = new Error("native abort");
      const pending = http.json(c.accounts[0]!, "rest/api/3/myself", controller.signal);
      await ready;
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { http.close(); }
  });
  it("never retries binary responses", async () => {
    const c = config(); const fetcher = mockFetch(() => json({}, 503)); const http = new HttpClient(c, fetcher);
    try {
      await expect(http.read(c.accounts[0]!, "rest/api/3/attachment/content/101?redirect=false", signal(), async () => {}, undefined, true)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { http.close(); }
  });
  it("honours Retry-After within the total budget", async () => {
    vi.useFakeTimers();
    const c = config();
    const fetcher = mockFetch(() => json({ accountId: "known" }));
    fetcher.mockImplementationOnce(async () => json({}, 429, { "retry-after": "1" }));
    const http = new HttpClient(c, fetcher);
    try {
      const pending = http.json(c.accounts[0]!, "rest/api/3/myself", signal());
      await vi.advanceTimersByTimeAsync(999);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ accountId: "known" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { http.close(); vi.useRealTimers(); }
  });
});
