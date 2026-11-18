import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeStore } from "../../src/state/store.js";
import { reviewProposal } from "../../src/state/review.js";
import { changeReview, reviewHTML } from "../../src/core/review.js";
import { parseArguments } from "../../src/cli.js";
import { planFixture } from "../state-fixtures.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });
async function fixture() {
  const data = await mkdtemp("/tmp/opencode/jira-review-"); roots.push(data);
  const now = new Date(); const plan = planFixture({ createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600000).toISOString() });
  const store = new ChangeStore(data); store.prepare(plan); const staging = store.paths.staging; store.close();
  return { data, plan, staging };
}
describe("[REV-01/02][VIA-04][PR-04–PR-06] complete private review and exact permission resource", () => {
  it("renders all source literally without scripts, remote assets or active external links", () => {
    const plan = planFixture({ summary: '<script>alert("hostile")</script>', payload: { text: "<img src=https://evil.invalid>" } });
    const html = reviewHTML(changeReview(plan));
    expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>"); expect(html).not.toContain("<img"); expect(html).not.toContain("<a ");
    expect(html).toContain("default-src 'none'"); expect(html).toContain(changeReview(plan).reviewHash);
  });
  it("rejects an oversized review instead of returning a truncated approval view", () => {
    expect(() => changeReview(planFixture({ payload: { text: "x".repeat(270000) } }))).toThrow();
  });
  it("registers the exact view hash only after the local review callback and removes its file", async () => {
    const f = await fixture(); const messages: string[] = []; let path = "";
    await reviewProposal(f.plan.id, { print: (text) => { messages.push(text); }, readHash: async () => {
      path = fileURLToPath(messages[0]!.match(/file:\/\/[^\n]+/)![0]);
      expect(await readFile(path, "utf8")).toContain(changeReview(f.plan).reviewHash);
      return changeReview(f.plan).reviewHash;
    } }, { data: f.data });
    expect(await readdir(f.staging)).toEqual([]); const store = new ChangeStore(f.data);
    try { expect(store.hasReviewed(f.plan.id, changeReview(f.plan).reviewHash)).toBe(true); expect(store.get(f.plan.id).execution.state).toBe("prepared"); expect(store.get(f.plan.id).execution.revision).toBe(1); }
    finally { store.close(); }
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not persist review evidence when the hash is absent or different", async () => {
    const f = await fixture();
    await expect(reviewProposal(f.plan.id, { print() {}, readHash: async () => "wrong" }, { data: f.data })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const store = new ChangeStore(f.data); try { expect(store.hasReviewed(f.plan.id, changeReview(f.plan).reviewHash)).toBe(false); } finally { store.close(); }
    expect(await readdir(f.staging)).toEqual([]);
  });
  it("keeps review hashes bound to audience, source, files and the proposal context", () => {
    const base = planFixture(); const review = changeReview(base);
    for (const plan of [planFixture({ id: "other" }), planFixture({ sessionID: "other" }), planFixture({ payload: { changed: true } })]) {
      expect(changeReview(plan).reviewHash).not.toBe(review.reviewHash); expect(changeReview(plan).resource).not.toBe(review.resource);
    }
    expect(review.resource).not.toMatch(/[?*]/);
  });
  it("accepts only the implemented local CLI syntax, without unattended confirmation flags", () => {
    expect(parseArguments(["review", "--global", "--proposal", "proposal-1"])).toMatchObject({ command: "review", proposalId: "proposal-1" });
    for (const args of [["review", "--global"], ["review", "--global", "--proposal", "../escape"], ["review", "--global", "--proposal", "x", "--yes"]]) expect(() => parseArguments(args)).toThrow();
  });
});
