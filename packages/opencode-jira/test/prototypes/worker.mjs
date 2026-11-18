import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { PersistencePrototype } from "./persistence.ts";
import { now, syntheticPlan } from "./fixtures.ts";

globalThis.fetch = () => { throw new Error("Network is not available in the persistence prototype"); };
const [directory, checkpoint] = process.argv.slice(2);
let armed = false;
let store;
try {
  store = new PersistencePrototype(directory, () => {
    if (armed) process.kill(process.pid, "SIGKILL");
  });
  if (checkpoint !== "hold") {
    if (checkpoint === "crash-prepare") armed = true;
    store.prepare(syntheticPlan());
    let result = store.claim("proposal-1", 0, now);
    if (checkpoint === "crash-sending") armed = true;
    if (checkpoint !== "claimed") {
      result = store.sending("proposal-1", result.execution.revision, "step-1", now);
      if (checkpoint !== "sending") {
        const descriptor = openSync(join(directory, "synthetic-remote-ledger"), "a", 0o600);
        try { writeSync(descriptor, "synthetic-step-1\n"); fsyncSync(descriptor); }
        finally { closeSync(descriptor); }
        if (checkpoint !== "accepted") {
          result = store.confirm("proposal-1", result.execution.revision, "step-1", { remoteIds: ["remote-1"], temporaryAttachmentIds: [], confirmedAt: now });
          if (checkpoint === "verified") store.verified("proposal-1", result.execution.revision, "step-1", now);
        }
      }
    }
  }
  process.send({ checkpoint });
  process.once("message", () => { store.close(); process.disconnect(); });
} catch (error) {
  store?.close();
  process.send({ error: error.code ?? "UNEXPECTED" }, () => process.exit(1));
}
