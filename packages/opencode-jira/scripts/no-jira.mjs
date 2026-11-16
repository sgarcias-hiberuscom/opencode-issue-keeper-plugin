import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

function guard(value) {
  const host = value instanceof URL ? value.hostname
    : typeof value === "string" ? new URL(value).hostname
      : value?.hostname ?? value?.host ?? "";
  if (/(?:^|\.)atlassian\.net$|(?:^|\.)atlassian\.com$/i.test(String(host).split(":")[0])) {
    throw new Error("Jira network is prohibited in installer checks");
  }
}
for (const module of [http, https]) for (const name of ["request", "get"]) {
  const original = module[name];
  module[name] = function (...args) { guard(args[0]); return original.apply(this, args); };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  guard(input instanceof Request ? input.url : input);
  return originalFetch(input, init);
};
syncBuiltinESMExports();
