import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { IssueKeeperError } from "../errors.js";

export interface SessionScope { directory: string; locationID: string }

export async function resolveSessionScope(
  getSession: () => Promise<{ location: { directory: string } }>,
  compatibleDirectory: string,
): Promise<SessionScope> {
  try {
    const session = await getSession();
    const directory = await realpath(session.location.directory);
    if (directory !== compatibleDirectory) throw new Error();
    return { directory, locationID: createHash("sha256").update(directory).digest("hex") };
  } catch {
    throw new IssueKeeperError("FILE_ACCESS_DENIED", "No se puede validar la ubicación de la sesión; vuelva a cargar el plugin.");
  }
}
