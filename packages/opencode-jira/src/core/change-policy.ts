import { createHash } from "node:crypto";
import type { Account, Config } from "../config.js";
import { canonicalJSON } from "./proposals.js";

export function changePolicyFingerprint(config: Config, account: Account): string {
  return createHash("sha256").update(canonicalJSON({
    version: 1, account: account.id, site: account.siteUrl, authentication: account.auth.mode,
    cloudId: account.auth.mode === "cloud-scoped-token" ? account.auth.cloudId : null,
    readOnly: account.readOnly, serviceManagement: account.serviceManagement,
    restrictedProjects: [...account.restrictedProjects].sort(), restrictedUpdateFields: [...account.restrictedUpdateFields].sort(),
    changes: config.changes, attachments: { ...config.attachments, uploadRoots: [...config.attachments.uploadRoots].sort() },
  })).digest("hex");
}
