import type { Account } from "../config.js";
import { apiUrl } from "../http.js";
import { invalidResponse } from "../errors.js";

export function attachmentLinkId(account: Account, input: string): string {
  let link: URL;
  try { link = new URL(input); } catch { invalidResponse(); }
  const root = apiUrl(account, "rest/api/3/myself");
  const prefix = root.pathname.replace(/rest\/api\/3\/myself$/, "");
  const direct = link.origin === account.siteUrl && /^\/rest\/api\/[23]\/attachment\/[1-9][0-9]*$/.test(link.pathname);
  const gateway = link.origin === root.origin && link.pathname.startsWith(prefix) && /^rest\/api\/[23]\/attachment\/[1-9][0-9]*$/.test(link.pathname.slice(prefix.length));
  const match = /\/rest\/api\/[23]\/attachment\/([1-9][0-9]*)$/.exec(link.pathname);
  if ((!direct && !gateway) || link.username || link.password || link.search || link.hash || !match) invalidResponse();
  return match[1]!;
}
