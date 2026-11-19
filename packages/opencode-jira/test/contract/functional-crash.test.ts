import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeFixture } from "../change-fixtures.js";
import { verifyRecorded } from "../../src/state/operator.js";
import { planHash } from "../../src/core/proposals.js";

const fixtures: Awaited<ReturnType<typeof changeFixture>>[] = []; const children: ChildProcess[] = [];
async function kill(child: ChildProcess) { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } }
beforeEach(() => vi.stubEnv("IK_TEST_WORK", "synthetic-token"));
afterEach(async () => { for (const child of children.splice(0)) await kill(child); for (const f of fixtures.splice(0)) { await f.close(); await rm(f.root, { recursive: true, force: true }); } vi.unstubAllEnvs(); });
const cases: Array<["fields" | "transition" | "comment" | "upload", "ticket" | "internal" | "public", string, "sending" | "accepted" | "confirmed" | "verified"]> = [];
for (const kind of ["fields", "transition"] as const) for (const checkpoint of ["sending", "accepted", "confirmed"] as const) cases.push([kind, "ticket", "mutation", checkpoint]);
for (const audience of ["ticket", "internal", "public"] as const) for (const checkpoint of ["sending", "accepted", "confirmed"] as const) cases.push(["comment", audience, "mutation", checkpoint]);
for (const audience of ["ticket", "internal", "public"] as const) for (const target of audience === "ticket" ? ["file-1"] : ["file-1", "publish"]) for (const checkpoint of ["sending", "accepted", "confirmed", "verified"] as const) cases.push(["upload", audience, target, checkpoint]);

describe("[REC/APL/UP/CMT][RC-03–07] actual process recovery by type and phase", () => {
  it.each(cases)("survives %s/%s/%s SIGKILL at %s without duplicate emission", async (kind, audience, target, checkpoint) => {
    const f = await changeFixture(); fixtures.push(f);
    const plan = kind === "fields" ? await f.prepare("issue_update_prepare", { update: { labels: [{ add: "crash-tested" }] } }) : kind === "transition" ? await f.prepare("transition_prepare", { transitionId: "31" }) : kind === "comment" ? await f.prepare("comment_prepare", { audience, text: "Ana", mentions: [{ start: 0, end: 3, accountId: audience === "public" ? "customer" : "person" }] }) : await f.prepare("attachment_upload_prepare", { audience, files: [await f.source("a.txt"), await f.source("b.txt")], ...(audience !== "ticket" ? { comment: "Ana", mentions: [{ start: 0, end: 3, accountId: audience === "public" ? "customer" : "person" }] } : {}) });
    const hash = planHash(plan); const configuration = join(f.root, "synthetic-config.json"); await writeFile(configuration, JSON.stringify(f.c), { mode: 0o600 });
    const child = fork(fileURLToPath(new URL("../fixtures/functional-worker.mjs", import.meta.url)), [f.data, plan.id, configuration, checkpoint, target], { // Runtimes before 26 accept the transform flag for TypeScript workers; 26 removed it and the loader transforms instead.
      execArgv: [...(Number(process.versions.node.split(".")[0]!) < 26 ? ["--experimental-transform-types"] : []), "--experimental-loader", fileURLToPath(new URL("../fixtures/state-loader.mjs", import.meta.url))], env: { IK_TEST_WORK: "synthetic-token" }, serialization: "advanced", stdio: ["ignore", "ignore", "pipe", "ipc"] }); children.push(child);
    await new Promise<void>((resolve, reject) => {
      let stderr = ""; child.stderr!.on("data", (value) => { stderr += String(value); });
      child.once("error", reject); child.once("exit", () => reject(new Error(`Worker exited before checkpoint: ${stderr}`)));
      child.on("message", async (message: any) => {
        if (message.type === "checkpoint") { resolve(); return; }
        if (message.type !== "fetch") { reject(new Error(`Worker failure: ${message.code ?? message.type}`)); return; }
        try {
          const response = await f.fetcher(message.url, { method: message.method, headers: message.headers, ...(message.body ? { body: message.body } : {}) });
          const body = Buffer.from(await response.arrayBuffer());
          if (child.connected) child.send({ type: "response", id: message.id, body, status: response.status, headers: Object.fromEntries(response.headers) });
        } catch { if (child.connected) child.send({ type: "response", id: message.id, error: true }); }
      });
    });
    await kill(child);
    const accepted = f.ledger.length; const recovered = await f.saved(plan); expect(planHash(recovered.plan)).toBe(hash);
    expect(recovered.execution.state).toBe(checkpoint === "verified" && target === "publish" ? "applied" : "unknown");
    const verified = await verifyRecorded(plan.id, f.c, { data: f.data, fetcher: f.fetcher, authorizeDownload: async () => {} });
    expect(f.ledger).toHaveLength(accepted);
    const result = await f.harness.invoke("change_apply", { proposalId: plan.id });
    if (checkpoint === "sending" || checkpoint === "accepted") { expect(result.data.state).toBe("unknown"); expect(f.ledger).toHaveLength(accepted); }
    else {
      expect(result.data.state, JSON.stringify({ verified, result })).toBe("applied");
      expect(f.ledger).toHaveLength(kind !== "upload" ? 1 : audience === "ticket" ? 2 : 3);
    }
    expect(planHash((await f.saved(plan)).plan)).toBe(hash);
  }, 20000);
});
