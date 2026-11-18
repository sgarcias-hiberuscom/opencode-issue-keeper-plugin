import { describe, expect, it } from "vitest";
import { operatorSummary } from "../../src/state/operator.js";
import { planFixture, instant } from "../state-fixtures.js";
import { planHash, type StoredChange } from "../../src/core/proposals.js";

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
