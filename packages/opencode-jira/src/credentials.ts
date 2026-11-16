import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Account } from "./config.js";
import { IssueKeeperError } from "./errors.js";

export async function authorization(account: Account, env = process.env): Promise<string> {
  let token: string | undefined;
  try {
    if (account.auth.tokenFile) {
      if (process.platform === "win32") throw new Error();
      const file = await open(account.auth.tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error();
        const bytes = Buffer.alloc(16385);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 16384) throw new Error();
        token = bytes.subarray(0, bytesRead).toString("utf8");
      } finally { await file.close(); }
    } else if (account.auth.tokenEnv) {
      token = env[account.auth.tokenEnv];
    }
    token = token?.replace(/\r?\n$/, "");
    if (!token || !token.trim() || token.length > 16384 || /[\r\n\0]/.test(token)) throw new Error();
    return `Basic ${Buffer.from(`${account.auth.email}:${token}`, "utf8").toString("base64")}`;
  } catch {
    throw new IssueKeeperError("ACCOUNT_UNAVAILABLE", "Credencial ausente o no válida; revise la fuente y sus permisos en el servidor.");
  }
}
