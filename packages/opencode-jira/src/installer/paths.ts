import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { userDataDirectory } from "../state/paths.js";

export function installerPaths(env = process.env) {
  const home = env.HOME || homedir();
  const config = env.XDG_CONFIG_HOME || join(home, ".config");
  const data = env.XDG_DATA_HOME || join(home, ".local/share");
  if (![home, config, data].every(isAbsolute)) throw new Error("HOME y las rutas XDG deben ser absolutas.");
  return {
    config: join(config, "opencode"),
    data: userDataDirectory(env),
    instructions: join(config, "opencode/instructions/jira.md"),
    example: join(config, "opencode/instructions/account.example.jsonc"),
    manifest: join(data, "issuekeeper/opencode-jira/install-manifest.json"),
  };
}
export type InstallerPaths = ReturnType<typeof installerPaths>;
