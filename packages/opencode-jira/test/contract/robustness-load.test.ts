import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { config, configTwoSites, createService, issue, json, mockFetch } from "../helpers.js";
import { toolHarness } from "../harness.js";
import { HttpClient } from "../../src/http.js";
import type { Config } from "../../src/config.js";

let root: string;
beforeEach(async () => {
  await mkdir("/tmp/opencode", { recursive: true });
  root = await mkdtemp("/tmp/opencode/ik-robustness-load-");
  vi.stubEnv("IK_TEST_WORK", "work-secret");
  vi.stubEnv("IK_TEST_CLIENT", "client-secret");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function accountOf(c: Config, url: URL, init: RequestInit) {
  const scoped = url.hostname === "api.atlassian.com";
  const header = new Headers(init.headers).get("authorization") ?? "";
  const email = Buffer.from(header.slice(6), "base64").toString().split(":")[0];
  const account = c.accounts.find((a) => a.auth.email === email);
  expect(account).toBeDefined();
  expect(scoped).toBe(account!.auth.mode === "cloud-scoped-token");
  return account!;
}

function searchResponse(account: { id: string }) {
  const key = account.id === "client" ? "CL-1" : "IK-1";
  return json({ issues: [issue(key, key.split("-")[0])], isLast: true });
}

// Fetch double that keeps every request open until the test releases it, so
// in-flight concurrency can be measured per account and per site.
function controlled(c: Config) {
  const inflight = { total: 0, maxTotal: 0, byAccount: new Map<string, number>(), maxByAccount: new Map<string, number>(), bySite: new Map<string, number>(), maxBySite: new Map<string, number>() };
  const waiting: Array<() => void> = [];
  const started: number[] = [];
  const fetcher = mockFetch(async (url, init) => {
    const account = accountOf(c, url, init);
    started.push((JSON.parse(String(init.body)) as { maxResults: number }).maxResults);
    const bump = (map: Map<string, number>, max: Map<string, number>, key: string, delta: number) => {
      const value = (map.get(key) ?? 0) + delta;
      map.set(key, value);
      if (value > (max.get(key) ?? 0)) max.set(key, value);
    };
    inflight.total++;
    inflight.maxTotal = Math.max(inflight.maxTotal, inflight.total);
    bump(inflight.byAccount, inflight.maxByAccount, account.id, 1);
    bump(inflight.bySite, inflight.maxBySite, account.siteUrl, 1);
    try {
      await new Promise<void>((resolve) => { waiting.push(resolve); });
    } finally {
      inflight.total--;
      bump(inflight.byAccount, inflight.maxByAccount, account.id, -1);
      bump(inflight.bySite, inflight.maxBySite, account.siteUrl, -1);
    }
    return searchResponse(account);
  });
  async function drain<T>(pending: Promise<T>): Promise<T> {
    let finished = false;
    const done = pending.finally(() => { finished = true; });
    done.catch(() => {});
    while (!finished) {
      await tick();
      waiting.shift()?.();
    }
    return done;
  }
  return { fetcher, inflight, drain, waiting, started };
}

describe("[10.2] read concurrency and load", () => {
  it("[10.2][load] caps in-flight requests per alias", async () => {
    const c = config();
    const gate = controlled(c);
    const service = await createService(c, root, gate.fetcher);
    try {
      const h = await toolHarness(service);
      const results = await gate.drain(Promise.all(Array.from({ length: 40 }, () => h.invoke("issues_search", { account: "work", jql: "project = IK" }))));
      expect(results).toHaveLength(40);
      expect(results.every((r) => r.ok === true)).toBe(true);
      expect(gate.fetcher).toHaveBeenCalledTimes(40);
      expect(gate.inflight.maxByAccount.get("work")).toBe(c.http.maxConcurrentPerAccount);
      expect(gate.inflight.total).toBe(0);
    } finally { service.close(); }
  });

  it("[10.2][load] shares the site cap between aliases of the same site", async () => {
    const c = config();
    const gate = controlled(c);
    const service = await createService(c, root, gate.fetcher);
    try {
      const h = await toolHarness(service);
      const calls = ["work", "client"].flatMap((account) => Array.from({ length: 20 }, () => h.invoke("issues_search", { account, jql: "project = IK" })));
      const results = await gate.drain(Promise.all(calls));
      expect(results.every((r) => r.ok === true)).toBe(true);
      expect(gate.fetcher).toHaveBeenCalledTimes(40);
      expect(gate.inflight.maxBySite.get("https://example.atlassian.net")).toBe(c.http.maxConcurrentPerAccount);
      for (const max of gate.inflight.maxByAccount.values()) expect(max).toBeLessThanOrEqual(c.http.maxConcurrentPerAccount);
      expect(gate.inflight.total).toBe(0);
    } finally { service.close(); }
  });

  it("[10.2][load] isolates two sites", async () => {
    const c = configTwoSites();
    const gate = controlled(c);
    const service = await createService(c, root, gate.fetcher);
    try {
      const h = await toolHarness(service);
      const order = ["work", "client"] as const;
      const calls = order.flatMap((account) => Array.from({ length: 20 }, () => h.invoke("issues_search", { account, jql: "project = IK" })));
      const results = await gate.drain(Promise.all(calls));
      expect(results.every((r) => r.ok === true)).toBe(true);
      for (const result of results.slice(0, 20)) {
        expect(result.account).toBe("work");
        expect(result.data.values.map((v: { key: string }) => v.key)).toEqual(["IK-1"]);
      }
      for (const result of results.slice(20)) {
        expect(result.account).toBe("client");
        expect(result.data.values.map((v: { key: string }) => v.key)).toEqual(["CL-1"]);
      }
      expect(gate.inflight.maxBySite.get("https://example.atlassian.net")).toBe(c.http.maxConcurrentPerAccount);
      expect(gate.inflight.maxBySite.get("https://client.atlassian.net")).toBe(c.http.maxConcurrentPerAccount);
      expect(gate.inflight.total).toBe(0);
    } finally { service.close(); }
  });

  it("[10.2][429] honours Retry-After and caps attempts under load", async () => {
    vi.useFakeTimers();
    const c = config();
    c.http.maxConcurrentPerAccount = 1;
    const calls = new Map<string, number>();
    const fetcher = mockFetch((url) => {
      const seen = (calls.get(url.pathname) ?? 0) + 1;
      calls.set(url.pathname, seen);
      return seen === 1 ? json({}, 429, { "retry-after": "1" }) : json({ accountId: "known" });
    });
    const http = new HttpClient(c, fetcher);
    try {
      const signal = new AbortController().signal;
      const pending = Array.from({ length: 4 }, (_, index) => http.json(c.accounts[0]!, `rest/api/3/issue/IK-${index + 1}`, signal));
      const settled = Promise.all(pending);
      await vi.advanceTimersByTimeAsync(0);
      // The permit is released during the wait, so all first attempts run before any retry.
      expect(fetcher).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await settled).toHaveLength(4);
      expect(fetcher).toHaveBeenCalledTimes(8);
      for (const seen of calls.values()) expect(seen).toBe(2);
      expect(Math.max(...calls.values())).toBeLessThanOrEqual(c.http.readMaxAttempts);
    } finally { http.close(); }
  });

  it("[10.2][cancel] releases queued slots on abort", async () => {
    const c = config();
    const gate = controlled(c);
    const service = await createService(c, root, gate.fetcher);
    try {
      const h = await toolHarness(service);
      const controllers = Array.from({ length: 10 }, () => new AbortController());
      const calls = controllers.map((controller, index) => h.invoke("issues_search", { account: "work", jql: "project = IK", maxResults: index + 1 }, controller.signal));
      const settled = calls.map((call) => call.then((value) => ({ value }), (error: unknown) => ({ error })));
      while (gate.inflight.total < c.http.maxConcurrentPerAccount) await tick();
      for (let i = 0; i < 20; i++) await tick();
      expect(gate.inflight.total).toBe(c.http.maxConcurrentPerAccount);
      const started = new Set(gate.started);
      expect(started.size).toBe(c.http.maxConcurrentPerAccount);
      const reason = new Error("caller cancelled");
      const queued = controllers.map((_, index) => index).filter((index) => !started.has(index + 1));
      const aborted = queued.slice(0, 5);
      const survivors = controllers.map((_, index) => index).filter((index) => !aborted.includes(index));
      for (const index of aborted) controllers[index]!.abort(reason);
      const outcomes = await gate.drain(Promise.all(settled));
      for (const index of aborted) expect(outcomes[index]).toEqual({ error: reason });
      for (const index of survivors) expect(outcomes[index]).toMatchObject({ value: { ok: true } });
      expect(gate.fetcher).toHaveBeenCalledTimes(survivors.length);
      expect(gate.inflight.total).toBe(0);
    } finally { service.close(); }
  });

  it("[10.2][timeout] does not leak slots after timeouts", async () => {
    const c = config();
    c.http.timeoutMs = 50;
    c.http.readMaxAttempts = 1;
    let hang = true;
    const fetcher = mockFetch((_url, init) => {
      if (!hang) return searchResponse({ id: "work" });
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    });
    const service = await createService(c, root, fetcher);
    try {
      const h = await toolHarness(service);
      const stuck = await Promise.all(Array.from({ length: 3 }, () => h.invoke("issues_search", { account: "work", jql: "project = IK" })));
      for (const result of stuck) expect(result).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
      hang = false;
      const fresh = await h.invoke("issues_search", { account: "work", jql: "project = IK" });
      expect(fresh.ok).toBe(true);
    } finally { service.close(); }
  });
});
