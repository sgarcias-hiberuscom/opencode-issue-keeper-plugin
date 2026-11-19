import { rm } from "node:fs/promises";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeFixture } from "../change-fixtures.js";
import { json } from "../helpers.js";
import { statePaths } from "../../src/state/paths.js";

const fixtures: Awaited<ReturnType<typeof changeFixture>>[] = [];
beforeEach(() => {
  vi.stubEnv("IK_TEST_WORK", "synthetic-token");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.close(); await rm(f.root, { recursive: true, force: true }); }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function fixture() {
  const f = await changeFixture();
  fixtures.push(f);
  f.c.http.maxConcurrentPerAccount = 3;
  f.c.http.readMaxAttempts = 3;
  return f;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const isMutation = (init: RequestInit) => init.method === "POST" || init.method === "PUT";

// Wraps the synthetic Jira so every request is observed; mutations can be
// intercepted and reads can be held open until the test releases them.
type Fetcher = typeof fetch;
function observe(f: Awaited<ReturnType<typeof fixture>>, options: { mutation?: (url: Parameters<Fetcher>[0], init: RequestInit, base: Fetcher) => Response | Promise<Response>; holdReads?: boolean } = {}) {
  const base = f.fetcher.getMockImplementation()!;
  const state = { inflight: 0, maxInflight: 0, started: 0, mutations: 0, held: [] as Array<() => void>, open: !options.holdReads };
  f.fetcher.mockImplementation(async (url, init) => {
    const request = init ?? {};
    if (isMutation(request)) {
      state.mutations++;
      if (options.mutation) return options.mutation(url, request, base);
      return base(url, request);
    }
    state.started++;
    state.inflight++;
    state.maxInflight = Math.max(state.maxInflight, state.inflight);
    try {
      if (!state.open) await new Promise<void>((resolve) => { state.held.push(resolve); });
      else await tick();
      return await base(url, request);
    } finally { state.inflight--; }
  });
  return {
    state,
    release() { state.open = true; for (const resolve of state.held.splice(0)) resolve(); },
  };
}

describe("[10.1][10.4] writes under load", () => {
  it("[10.1][retry] never retries a mutation on 429", async () => {
    const f = await fixture();
    const plan = await f.prepare("comment_prepare", { audience: "ticket", text: "mensaje" });
    f.faults.rejectAt = 1;
    const result = await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(result.data.state).toBe("failed");
    expect(result.data.steps[0]).toMatchObject({ state: "failed", rejectionStatus: 429, error: { code: "RATE_LIMITED", retryable: false } });
    expect(f.ledger).toHaveLength(1);
    expect((await f.saved(plan)).execution.state).toBe("failed");
    await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(f.ledger).toHaveLength(1);
  });

  it.each(["http-503", "network-error"] as const)("[10.1][retry] never retries a mutation on %s", async (kind) => {
    const f = await fixture();
    const plan = await f.prepare("comment_prepare", { audience: "ticket", text: "mensaje" });
    const watch = observe(f, { mutation: () => { if (kind === "network-error") throw new TypeError("fetch failed"); return json({}, 503); } });
    const result = await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(watch.state.mutations).toBe(1);
    expect(result.data.state).toBe("unknown");
    expect(result.data.error).toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN", retryable: false });
    await f.harness.invoke("change_apply", { proposalId: plan.id });
    expect(watch.state.mutations).toBe(1);
  });

  it("[10.4][load] mixes reads and one apply on the same site", async () => {
    const f = await fixture();
    const plan = await f.prepare("comment_prepare", { audience: "ticket", text: "mensaje" });
    const watch = observe(f);
    const reads = Array.from({ length: 20 }, () => f.harness.invoke("issue_get", { account: "work", issueKey: "IK-1", fields: ["summary"] }));
    const [applied, ...results] = await Promise.all([f.harness.invoke("change_apply", { proposalId: plan.id }), ...reads]);
    expect(applied.data.state).toBe("applied");
    expect(results.every((r) => r.ok === true)).toBe(true);
    expect(watch.state.mutations).toBe(1);
    expect(f.ledger).toHaveLength(1);
    expect(watch.state.maxInflight).toBeGreaterThan(1);
    expect(watch.state.maxInflight).toBeLessThanOrEqual(f.c.http.maxConcurrentPerAccount);
    expect(watch.state.inflight).toBe(0);
  }, 20000);

  it("[10.4][cancel] aborting while waiting for a slot sends nothing", async () => {
    const f = await fixture();
    const plan = await f.prepare("comment_prepare", { audience: "ticket", text: "mensaje" });
    const watch = observe(f, { holdReads: true });
    const blockers = Array.from({ length: 3 }, () => f.harness.invoke("issue_get", { account: "work", issueKey: "IK-1", fields: ["summary"] }));
    while (watch.state.inflight < f.c.http.maxConcurrentPerAccount) await tick();
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const applying = f.harness.invoke("change_apply", { proposalId: plan.id }, controller.signal);
    const rejected = expect(applying).rejects.toBe(reason);
    // Abort only once the engine has claimed the proposal, so the outcome is deterministic across runtimes.
    const executionState = () => {
      const db = new Database(statePaths(f.data).database, { readonly: true });
      try { return String((db.prepare("SELECT state FROM executions WHERE id=?").get(plan.id) as { state?: unknown } | undefined)?.state); } finally { db.close(); }
    };
    for (let i = 0; i < 1000 && executionState() !== "applying"; i++) await tick();
    expect(executionState()).toBe("applying");
    expect(watch.state.started).toBe(3);
    controller.abort(reason);
    await rejected;
    watch.release();
    expect((await Promise.all(blockers)).every((r) => r.ok === true)).toBe(true);
    expect(watch.state.mutations).toBe(0);
    expect(f.ledger).toHaveLength(0);
    const saved = await f.saved(plan);
    expect(saved.execution.state).toBe("failed");
    expect(saved.receipts).toEqual({});
    expect(saved.execution.steps.every((step) => step.state === "pending")).toBe(true);
  }, 20000);

  it("[10.4][concurrency] two concurrent applies under load send once", async () => {
    const f = await fixture();
    const plan = await f.prepare("comment_prepare", { audience: "ticket", text: "mensaje" });
    const watch = observe(f);
    const reads = Array.from({ length: 10 }, () => f.harness.invoke("issue_get", { account: "work", issueKey: "IK-1", fields: ["summary"] }));
    const [first, second] = await Promise.all([
      f.harness.invoke("change_apply", { proposalId: plan.id }),
      f.harness.invoke("change_apply", { proposalId: plan.id }),
      ...reads,
    ]);
    expect(watch.state.mutations).toBe(1);
    expect(f.ledger).toHaveLength(1);
    for (const result of [first, second]) {
      if (result.ok) expect(result.data.state).toBe("applied");
      else expect(result.error.code).toBe("CONFLICT");
    }
    expect([first, second].some((result) => result.ok && result.data.state === "applied")).toBe(true);
    expect((await f.saved(plan)).execution.state).toBe("applied");
  }, 20000);

  it("[6.6][journal] persists sending before every request under load", async () => {
    const f = await fixture();
    const files = [await f.source("a.txt"), await f.source("b.txt")];
    const plan = await f.prepare("attachment_upload_prepare", { audience: "ticket", files });
    const sending: string[][] = [];
    const watch = observe(f, {
      mutation: (url, init, base) => {
        const db = new Database(statePaths(f.data).database, { readonly: true });
        try {
          const rows = db.prepare("SELECT document FROM executions WHERE state='applying'").all() as Array<{ document: string }>;
          sending.push(rows.flatMap((row) => (JSON.parse(row.document).steps as Array<{ id: string; state: string }>).filter((step) => step.state === "sending").map((step) => step.id)));
        } finally { db.close(); }
        return base(url, init);
      },
    });
    const reads = Array.from({ length: 10 }, () => f.harness.invoke("issue_get", { account: "work", issueKey: "IK-1", fields: ["summary"] }));
    const [applied] = await Promise.all([f.harness.invoke("change_apply", { proposalId: plan.id }), ...reads]);
    expect(applied.data.state).toBe("applied");
    expect(watch.state.mutations).toBe(plan.steps.length);
    expect(sending.every((ids) => ids.length === 1)).toBe(true);
    expect(sending.map((ids) => ids[0])).toEqual(plan.steps.map((step) => step.id));
  }, 20000);
});
