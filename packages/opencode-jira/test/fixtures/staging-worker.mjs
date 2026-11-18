import { ChangeStore } from "../../src/state/store.ts";
import { stageUploadFiles } from "../../src/state/staging.ts";

globalThis.fetch = () => { throw new Error("Synthetic worker has no network"); };
const [data, location, path, checkpoint] = process.argv.slice(2);
let writes = 0;
const store = new ChangeStore(data);
try {
  await stageUploadFiles(store, [{ path, publishedName: "file.bin" }], {
    location, uploadRoots: ["exports"], deniedPaths: [], signal: new AbortController().signal,
    authorizeRead: async () => {}, revalidateContext: async () => {},
    limits: { maxFileBytes: 1024 * 1024, maxBatchBytes: 1024 * 1024, maxFilesPerUpload: 1, transferTimeoutMs: 600000 },
    fault: async (point) => {
      if (checkpoint === "copying" && point === "before-write" && ++writes === 2 || checkpoint === "copied" && point === "after-copy") {
        process.send({ checkpoint, node: process.version });
        await new Promise((resolve) => process.once("message", resolve));
      }
    },
  });
} catch (error) {
  process.send({ error: error.reason ?? error.code ?? "UNEXPECTED" }, () => process.exit(1));
} finally { store.close(); }
