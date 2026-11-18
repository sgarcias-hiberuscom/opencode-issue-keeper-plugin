import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ChangeStore } from "../../src/state/store.ts";
import { instant, planFixture } from "../state-fixtures.ts";

globalThis.fetch = () => { throw new Error("Synthetic worker has no network"); };
const [data, checkpoint] = process.argv.slice(2);
let armed = false;
let store;
try {
  store = new ChangeStore(data, { now: () => new Date(instant), fault: () => { if (armed) process.kill(process.pid, "SIGKILL"); } });
  if (checkpoint !== "hold") {
    if (checkpoint === "crash-prepare") armed = true;
    store.prepare(planFixture());
    let result = store.claim("proposal-1", 0);
    if (checkpoint === "crash-sending") armed = true;
    if (checkpoint !== "claimed") {
      result = store.sending("proposal-1", result.execution.revision, "step-1");
      if (checkpoint !== "sending") {
        const descriptor = openSync(join(data, "synthetic-remote-ledger"), "a", 0o600);
        try { writeSync(descriptor, "synthetic-step-1\n"); fsyncSync(descriptor); } finally { closeSync(descriptor); }
        if (checkpoint !== "accepted") {
          result = store.confirm("proposal-1", result.execution.revision, "step-1", { remoteIds: ["remote:1"], temporaryAttachmentIds: [], confirmedAt: instant });
          if (checkpoint === "verified") store.verified("proposal-1", result.execution.revision, "step-1");
        }
      }
    }
  }
  process.send({ checkpoint, node: process.version });
  process.once("message", () => { store.close(); process.disconnect(); });
} catch (error) {
  store?.close();
  process.send({ error: error.reason ?? "UNEXPECTED" }, () => process.exit(1));
}
