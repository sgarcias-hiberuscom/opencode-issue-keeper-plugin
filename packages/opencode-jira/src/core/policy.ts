import type { Account } from "../config.js";
import { IssueKeeperError } from "../errors.js";

export function checkProject(account: Account, projectKey: string): void {
  if (account.restrictedProjects.includes(projectKey)) {
    throw new IssueKeeperError("FORBIDDEN", "El proyecto real del recurso está restringido para esta cuenta.");
  }
}
