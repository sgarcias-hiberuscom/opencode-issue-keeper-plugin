import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient, retryAfter } from "../../src/http.js";
import { config, json, mockFetch, signal } from "../helpers.js";

beforeEach(() => vi.stubEnv("IK_TEST_WORK", "private-secret"));
afterEach(() => vi.unstubAllEnvs());

describe("safe HTTP", () => {
  it.each([[400, "VALIDATION_FAILED"], [401, "AUTH_FAILED"], [403, "FORBIDDEN"], [404, "NOT_FOUND_OR_NO_ACCESS"], [409, "CONFLICT"], [413, "RESPONSE_TOO_LARGE"], [422, "VALIDATION_FAILED"], [429, "RATE_LIMITED"], [503, "NETWORK_ERROR"]])("maps HTTP %i without exposing remote bodies", async (status, code) => {
    const c = config(); c.http.readMaxAttempts = 1;
    const fetcher = mockFetch(() => json({ errorMessages: ["private-secret reflected by Jira"] }, Number(status)));
    const http = new HttpClient(c, fetcher);
    await expect(http.json(c.accounts[0]!, "rest/api/3/myself", signal())).rejects.toMatchObject({ code });
    expect(fetcher).toHaveBeenCalledTimes(1);
    http.close();
  });
  it.each([
    () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
    () => new Response("{invalid", { headers: { "content-type": "application/json" } }),
  ])("rejects non-JSON and malformed JSON", async (response) => {
    const c = config(); const http = new HttpClient(c, mockFetch(response));
    await expect(http.json(c.accounts[0]!, "rest/api/3/myself", signal())).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    http.close();
  });
  it("caps actual streaming bytes without Content-Length", async () => {
    const c = config(); c.http.maxResponseBytes = 10;
    const http = new HttpClient(c, mockFetch(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"text":"too large"}')); controller.close(); } }), { headers: { "content-type": "application/json" } })));
    await expect(http.json(c.accounts[0]!, "rest/api/3/myself", signal())).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    http.close();
  });
  it("handles 204 without parsing JSON", async () => {
    const c = config(); const http = new HttpClient(c, mockFetch(() => new Response(null, { status: 204 })));
    expect(await http.json(c.accounts[0]!, "rest/api/3/myself", signal())).toBeUndefined();
    http.close();
  });
  it("never follows redirects or forwards authorization", async () => {
    const c = config(); const fetcher = mockFetch((_, init) => {
      expect(init.redirect).toBe("error");
      expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
      return new Response(null, { status: 303, headers: { location: "https://evil.com/private-secret" } });
    });
    const http = new HttpClient(c, fetcher);
    await expect(http.json(c.accounts[0]!, "rest/api/3/myself", signal())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fetcher).toHaveBeenCalledTimes(1); http.close();
  });
  it("respects Retry-After exceeding the deadline and parses dates", async () => {
    const c = config(); c.http.timeoutMs = 50;
    const fetcher = mockFetch(() => json({}, 429, { "retry-after": "120" }));
    const http = new HttpClient(c, fetcher);
    await expect(http.json(c.accounts[0]!, "rest/api/3/myself", signal())).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 120 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(retryAfter(new Date(10000).toUTCString(), 0)).toBe(10);
    expect(retryAfter("garbage")).toBeUndefined(); http.close();
  });
  it("retries only transient semantic reads within the attempt budget", async () => {
    const c = config(); c.http.readMaxAttempts = 2;
    let attempts = 0;
    const fetcher = mockFetch(() => ++attempts === 1 ? json({}, 503) : json({ issues: [] }));
    const http = new HttpClient(c, fetcher);
    expect(await http.json(c.accounts[0]!, "rest/api/3/search/jql", signal(), { jql: 'project = "IK"' })).toEqual({ issues: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "POST")).toBe(true);
    await expect(http.json(c.accounts[0]!, "rest/api/3/myself", signal(), {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    http.close();
  });
  it("enforces cancellation, timeout and unload", async () => {
    const c = config(); c.http.timeoutMs = 20;
    const fetcher = mockFetch((_, init) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("raw secret")), { once: true })));
    const http = new HttpClient(c, fetcher);
    await expect(http.json(c.accounts[0]!, "rest/api/3/myself", signal())).rejects.toMatchObject({ code: "TIMEOUT" });
    const controller = new AbortController(); controller.abort();
    await expect(http.json(c.accounts[0]!, "rest/api/3/myself", controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
    http.close();
    await expect(http.json(c.accounts[0]!, "rest/api/3/myself", signal())).rejects.toMatchObject({ code: "CANCELLED" });
  });
  it("shares site concurrency between profiles and cancels queued calls", async () => {
    vi.stubEnv("IK_TEST_CLIENT", "other-secret");
    const c = config(); c.http.maxConcurrentPerAccount = 1;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const fetcher = mockFetch(() => new Promise<Response>((resolve) => { started(); finish = () => resolve(json({ accountId: "me" })); }));
    const http = new HttpClient(c, fetcher);
    const first = http.json(c.accounts[0]!, "rest/api/3/myself", signal());
    await ready;
    const controller = new AbortController();
    const second = http.json(c.accounts[1]!, "rest/api/3/myself", controller.signal);
    controller.abort();
    await expect(second).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    finish(); await first; http.close();
  });
  it("cancels a stalled response stream when the total timeout expires", async () => {
    const c = config(); c.http.timeoutMs = 20;
    const cancelled = vi.fn();
    const http = new HttpClient(c, mockFetch(() => new Response(new ReadableStream({ cancel: cancelled }), { headers: { "content-type": "application/json" } })));
    await expect(http.json(c.accounts[0]!, "rest/api/3/myself", signal())).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(cancelled).toHaveBeenCalledTimes(1); http.close();
  });
});
