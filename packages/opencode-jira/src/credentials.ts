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

export interface CredentialLease { readonly identity: string; readonly account: string; readonly site: string }
const leases = new WeakMap<CredentialLease, { authorization: string; configuration: string }>();

export async function captureCredential(account: Account, probe: (authorization: string) => Promise<string>): Promise<CredentialLease> {
  const header = await authorization(account);
  const identity = await probe(header);
  if (!identity || identity.length > 256 || /[\x00-\x1f\x7f]/.test(identity)) throw new IssueKeeperError("INVALID_RESPONSE", "Jira no proporcionó una identidad de escritura válida.");
  const lease = Object.freeze({ identity, account: account.id, site: account.siteUrl });
  leases.set(lease, { authorization: header, configuration: JSON.stringify(account) });
  return lease;
}

export async function boundAuthorization(lease: CredentialLease, account: Account): Promise<string> {
  const bound = leases.get(lease);
  if (!bound || bound.configuration !== JSON.stringify(account) || bound.authorization !== await authorization(account)) {
    throw new IssueKeeperError("CONFLICT", "La credencial o configuración cambió durante la validación; no se ha enviado el cambio.");
  }
  return bound.authorization;
}
