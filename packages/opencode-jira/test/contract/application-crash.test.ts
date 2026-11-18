import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeStore } from "../../src/state/store.js";
import { ChangeApplication, type ChangePorts } from "../../src/state/application.js";

const roots: string[] = []; const children: ChildProcess[] = [];
async function kill(child: ChildProcess) { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } }
afterEach(async () => { for (const child of children.splice(0)) await kill(child); for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });
describe("[G2][TST-01][RC-03/04] integrated application process recovery", () => {
  it.each(["review", "sending", "accepted", "confirmed", "verified"])("survives SIGKILL at %s without another emitter attempt", async (checkpoint) => {
    const data = await mkdtemp("/tmp/opencode/jira-app-crash-"); roots.push(data);
    const child = fork(fileURLToPath(new URL("../fixtures/application-worker.mjs", import.meta.url)), [data, checkpoint], {
      // Runtimes before 26 accept the transform flag for TypeScript workers; 26 removed it and the loader transforms instead.
      execArgv: [...(Number(process.versions.node.split(".")[0]!) < 26 ? ["--experimental-transform-types"] : []), "--experimental-loader", fileURLToPath(new URL("../fixtures/state-loader.mjs", import.meta.url))], env: {}, stdio: ["ignore", "ignore", "pipe", "ipc"],
    }); children.push(child);
    const ready = await new Promise((resolve, reject) => {
      let stderr = ""; child.stderr!.on("data", (value) => { stderr += String(value); });
      child.once("error", reject); child.once("exit", () => reject(new Error(`Worker exited early: ${stderr}`))); child.once("message", resolve);
    });
    expect(ready).toEqual({ checkpoint, node: process.version }); await kill(child);
    const store = new ChangeStore(data); const saved = store.get("proposal-1"); store.close();
    expect(saved.execution.state).toBe(checkpoint === "verified" ? "applied" : "unknown");
    expect(saved.execution.steps[0]!.state).toBe(({ review: "pending", sending: "unknown", accepted: "unknown", confirmed: "confirmed", verified: "confirmed" })[checkpoint]);
    const unexpected = async (): Promise<never> => { throw new Error("Recovery must not dispatch another operation"); };
    const ports: ChangePorts<unknown> = { validate: unexpected, present: unexpected, authorize: unexpected, send: unexpected, verify: unexpected };
    const application = new ChangeApplication(ports, { data });
    await expect(application.apply(saved.plan.id, { sessionID: saved.plan.sessionID, signal: new AbortController().signal, resolve: async () => ({ sessionID: saved.plan.sessionID, locationID: saved.plan.locationID }) })).resolves.toEqual(saved);
    const ledger = await readFile(join(data, "synthetic-remote-ledger"), "utf8").catch(() => "");
    expect(ledger).toBe(["accepted", "confirmed", "verified"].includes(checkpoint) ? "accepted-step-1\n" : "");
  });
});
