import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { operatorSummary, summarizeExecutions } from "../../src/state/operator.js";
import { ChangeStore } from "../../src/state/store.js";
import { statePaths } from "../../src/state/paths.js";
import { planFixture, instant } from "../state-fixtures.js";
import { planHash, type StoredChange } from "../../src/core/proposals.js";

const EMPTY_SHA256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

function progress(): StoredChange {
  const plan = planFixture({ kind: "upload", audience: "ticket", files: [{ stagedRef: "first", publishedName: "first.txt", size: 0, sha256: "a".repeat(64) }, { stagedRef: "second", publishedName: "second.txt", size: 0, sha256: "b".repeat(64) }], steps: [{ id: "file-1", kind: "mutation", fileRefs: ["first"] }, { id: "file-2", kind: "mutation", fileRefs: ["second"] }] });
  const payloadHash = planHash(plan);
  return { plan, payloadHash, execution: { proposalId: plan.id, payloadHash, state: "unknown", revision: 5, updatedAt: instant, steps: [{ id: "file-1", state: "confirmed" }, { id: "file-2", state: "pending" }] }, receipts: { "file-1": { remoteIds: ["100"], temporaryAttachmentIds: [], confirmedAt: instant, verifiedAt: instant } } };
}
describe("[M5][RES-01][RC-05–08] durable outcome classification", () => {
  it.each(["unknown", "failed"] as const)("identifies %s partial uploads without suggesting retries", (state) => {
    const saved = progress(); saved.execution.state = state;
    if (state === "failed") { saved.execution.steps[1]!.state = "failed"; saved.execution.steps[1]!.rejectionStatus = 429; }
    const summary = operatorSummary(saved);
    expect(summary.error).toMatchObject({ code: "PARTIAL_UPLOAD", retryable: false });
    expect(summary.steps[0]!.receipt).toEqual(saved.receipts["file-1"]);
    if (state === "failed") expect(summary.steps[1]).toMatchObject({ error: { code: "RATE_LIMITED", retryable: false } });
  });
  it.each(["sending", "unknown"] as const)("gives uncertainty precedence over an earlier receipt with a %s step", (state) => {
    const saved = progress(); saved.execution.steps[1]!.state = state;
    expect(operatorSummary(saved).error).toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN", retryable: false });
  });
  it("does not label a confirmed but unverified receipt as an accredited partial upload", () => {
    const saved = progress(); delete saved.receipts["file-1"]!.verifiedAt;
    expect(operatorSummary(saved).error?.code).toBe("WRITE_OUTCOME_UNKNOWN");
  });
  it("does not attach partial or uncertain errors to an applied receipt", () => {
    const saved = progress(); saved.execution.state = "applied"; saved.execution.steps[1]!.state = "confirmed"; saved.receipts["file-2"] = { remoteIds: ["101"], temporaryAttachmentIds: [], confirmedAt: instant, verifiedAt: instant };
    expect(operatorSummary(saved)).not.toHaveProperty("error");
  });
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });

function digestOf(data: string): string {
  return createHash("sha256").update(readFileSync(statePaths(data).database)).digest("hex");
}

describe("[11.4] global operator summary", () => {
  it("summarizes states, uncertainty and oldest pending without touching the store", async () => {
    const data = await mkdtemp("/tmp/opencode/jira-operator-summary-");
    roots.push(data);
    const store = new ChangeStore(data, { now: () => new Date(instant) });
    store.prepare(planFixture({ id: "prepared-1", issueId: "9001" }));
    for (const id of ["applied-1", "applied-2"]) {
      store.prepare(planFixture({ id, issueId: id === "applied-1" ? "9002" : "9003" }));
      store.claim(id, 0);
      store.sending(id, 1, "step-1");
      store.confirm(id, 2, "step-1", { remoteIds: ["100"], temporaryAttachmentIds: [], confirmedAt: instant });
      store.verified(id, 3, "step-1");
    }
    store.prepare(planFixture({ id: "uncertain-1", issueId: "9004" }));
    store.claim("uncertain-1", 0);
    store.sending("uncertain-1", 1, "step-1");
    store.stop("uncertain-1", 2, "step-1", "unknown");
    expect(store.countByState()).toEqual({ prepared: 1, applying: 0, applied: 2, failed: 0, unknown: 1 });
    store.close();
    const before = digestOf(data);
    expect(summarizeExecutions(data)).toEqual({
      states: { prepared: 1, applying: 0, applied: 2, failed: 0, unknown: 1 },
      uncertain: 1,
      partial: 0,
      oldestPendingAt: instant,
    });
    expect(digestOf(data)).toBe(before);
  });
  it("reports an empty summary when no store exists yet", async () => {
    const data = await mkdtemp("/tmp/opencode/jira-operator-summary-empty-");
    roots.push(data);
    expect(summarizeExecutions(data)).toEqual({ states: { prepared: 0, applying: 0, applied: 0, failed: 0, unknown: 0 }, uncertain: 0, partial: 0, oldestPendingAt: null });
  });
  it("flags a partial upload with files and an unverified receipt", async () => {
    const data = await mkdtemp("/tmp/opencode/jira-operator-summary-partial-");
    roots.push(data);
    const plan = planFixture({ id: "partial-1", kind: "upload", audience: "ticket", files: [{ stagedRef: "first", publishedName: "first.txt", size: 0, sha256: EMPTY_SHA256 }], steps: [{ id: "step-1", kind: "mutation", fileRefs: ["first"] }, { id: "step-2", kind: "mutation", fileRefs: [] }] });
    const store = new ChangeStore(data, { now: () => new Date(instant) });
    await writeFile(`${store.paths.staging}/first`, Buffer.alloc(0), { mode: 0o600 });
    store.prepare(plan);
    store.claim("partial-1", 0);
    store.sending("partial-1", 1, "step-1");
    store.confirm("partial-1", 2, "step-1", { remoteIds: ["100"], temporaryAttachmentIds: [], confirmedAt: instant });
    store.verified("partial-1", 3, "step-1", instant);
    store.close();
    const summary = summarizeExecutions(data);
    expect(summary.uncertain).toBe(0);
    expect(summary.partial).toBe(1);
    expect(summary.states.applying).toBe(1);
  });
});
