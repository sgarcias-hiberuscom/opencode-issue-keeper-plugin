import { install, uninstall } from "../../src/installer/index.ts";
import { installerPaths } from "../../src/installer/paths.ts";
import { join } from "node:path";

const [home, checkpoint, installed, version, action = "install"] = process.argv.slice(2);
globalThis.fetch = () => { throw new Error("Installer worker has no network"); };
const paths = installerPaths({ HOME: home, XDG_CONFIG_HOME: join(home, "config with spaces"), XDG_DATA_HOME: join(home, "data with spaces") });
const io = { accept: async () => true, print() {} };
const afterStep = async (step) => {
    if (step === checkpoint) {
      process.on("message", () => {});
      process.send({ checkpoint });
      await new Promise(() => {});
    }
};
if (action === "install") await install("local", io, { paths, prepare: async () => ({ installed, version }), afterStep });
else await uninstall(io, paths, { afterStep });
