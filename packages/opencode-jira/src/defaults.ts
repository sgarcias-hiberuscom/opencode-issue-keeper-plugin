export const defaults = Object.freeze({
  http: Object.freeze({ timeoutMs: 20000, readMaxAttempts: 3, maxResponseBytes: 1048576, maxConcurrentPerAccount: 3 }),
  output: Object.freeze({ pageSize: 25, maxPageSize: 100, maxTextChars: 12000 }),
  changes: Object.freeze({ ttlSeconds: 600, requireExpectedUpdated: true }),
  attachments: Object.freeze({
    enabled: true, uploadRoots: Object.freeze(["./exports"]), downloadDir: ".issuekeeper/downloads",
    maxFileBytes: 20971520, maxBatchBytes: 52428800, maxFilesPerUpload: 5, transferTimeoutMs: 120000, overwrite: false as const,
  }),
});

export function baseOptions() {
  return { accounts: [], ...structuredClone(defaults) };
}

export const basePermissions = [
  { action: "jira.accounts", resource: "*", effect: "allow" },
  { action: "jira.read", resource: "*", effect: "ask" },
  { action: "jira.write", resource: "*", effect: "ask" },
  { action: "jira.download", resource: "*", effect: "ask" },
  { action: "read", resource: "exports/*", effect: "ask" },
  { action: "edit", resource: ".issuekeeper/downloads/*", effect: "ask" },
] as const;
