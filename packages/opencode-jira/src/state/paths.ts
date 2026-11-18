import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

export function userDataDirectory(env = process.env): string {
  const home = env.HOME || homedir();
  const data = env.XDG_DATA_HOME || join(home, ".local/share");
  if (![home, data].every(isAbsolute)) throw new Error("HOME y XDG_DATA_HOME deben ser rutas absolutas.");
  return join(normalize(data), "issuekeeper/opencode-jira");
}

export function statePaths(data = userDataDirectory()) {
  if (!isAbsolute(data)) throw new Error("La ruta de datos debe ser absoluta.");
  const directory = join(data, "runtime");
  return { directory, owner: join(directory, "owner.sqlite"), database: join(directory, "changes.sqlite"), staging: join(directory, "staging") };
}
export type StatePaths = ReturnType<typeof statePaths>;
