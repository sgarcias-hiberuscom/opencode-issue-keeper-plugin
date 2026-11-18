import { isAbsolute, resolve, relative, sep } from "node:path";
import { z } from "zod";
import { IssueKeeperError } from "./errors.js";
import { defaults } from "./defaults.js";

export const Alias = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
export const ProjectKey = z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/);
export const Field = z.string().regex(/^(?:[a-zA-Z][a-zA-Z0-9_]{0,99})$/);
export const ReadField = Field.refine((field) => !["comment", "attachment", "worklog"].includes(field));
export const readFields = ["summary", "description", "status", "assignee", "reporter", "project", "updated", "labels", "priority", "issuetype"];
const integer = (max: number) => z.number().int().positive().max(max);
const path = z.string().min(1).max(4096).refine((v) => !v.includes("\0") && !v.startsWith("~"));
const source = {
  email: z.email().max(254).refine((v) => !v.includes(":")),
  tokenFile: path.refine(isAbsolute).optional(),
  tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/).optional(),
};
const auth = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("cloud-token"), ...source }),
  z.strictObject({ mode: z.literal("cloud-scoped-token"), cloudId: z.uuid(), ...source }),
]).refine((v) => Boolean(v.tokenFile) !== Boolean(v.tokenEnv));
const siteUrl = z.string().max(253).regex(/^https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net\/?$/).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(url.hostname)
      && !url.username && !url.password && !url.port && url.pathname === "/" && !url.search && !url.hash
      && !/[?#\\]/.test(value);
  } catch { return false; }
}).transform((v) => new URL(v).origin);

export const AccountSchema = z.strictObject({
  id: Alias,
  label: z.string().min(1).max(100).optional(),
  siteUrl,
  auth,
  readOnly: z.boolean().default(true),
  serviceManagement: z.strictObject({ enabled: z.boolean().default(false) }).prefault({}),
  restrictedProjects: z.array(ProjectKey).max(100).default([]),
  restrictedUpdateFields: z.array(Field).max(50).default([]),
});

export const ConfigSchema = z.strictObject({
  accounts: z.array(AccountSchema).max(50),
  defaultAccount: Alias.optional(),
  http: z.strictObject({
    timeoutMs: integer(120000).default(defaults.http.timeoutMs),
    readMaxAttempts: integer(5).default(defaults.http.readMaxAttempts),
    maxResponseBytes: integer(10485760).default(defaults.http.maxResponseBytes),
    maxConcurrentPerAccount: integer(10).default(defaults.http.maxConcurrentPerAccount),
  }).prefault({}),
  output: z.strictObject({
    pageSize: integer(100).default(defaults.output.pageSize),
    maxPageSize: integer(100).default(defaults.output.maxPageSize),
    maxTextChars: integer(100000).default(defaults.output.maxTextChars),
  }).prefault({}),
  changes: z.strictObject({
    ttlSeconds: integer(3600).default(defaults.changes.ttlSeconds),
    requireExpectedUpdated: z.boolean().describe("La fase 2 exige fecha real y frescura incluso si esta opción es false; no habilita escrituras sin expectedUpdated.").default(defaults.changes.requireExpectedUpdated),
  }).prefault({}),
  attachments: z.strictObject({
    enabled: z.boolean().default(defaults.attachments.enabled),
    uploadRoots: z.array(path).min(1).max(10).default([...defaults.attachments.uploadRoots]),
    downloadDir: path.default(defaults.attachments.downloadDir),
    maxFileBytes: integer(104857600).default(defaults.attachments.maxFileBytes),
    maxBatchBytes: integer(524288000).default(defaults.attachments.maxBatchBytes),
    maxFilesPerUpload: integer(20).default(defaults.attachments.maxFilesPerUpload),
    transferTimeoutMs: integer(600000).default(defaults.attachments.transferTimeoutMs),
    overwrite: z.literal(false).describe("Sólo false; nunca se sobrescriben descargas.").default(defaults.attachments.overwrite),
  }).prefault({}),
}).superRefine((config, ctx) => {
  const ids = config.accounts.map((a) => a.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["accounts"], message: "duplicate" });
  if (config.defaultAccount && !ids.includes(config.defaultAccount)) ctx.addIssue({ code: "custom", path: ["defaultAccount"], message: "unknown" });
  if (config.output.pageSize > config.output.maxPageSize) ctx.addIssue({ code: "custom", path: ["output", "pageSize"], message: "limit" });
  if (config.attachments.maxFileBytes > config.attachments.maxBatchBytes) ctx.addIssue({ code: "custom", path: ["attachments", "maxBatchBytes"], message: "limit" });
});

export type Config = z.infer<typeof ConfigSchema>;
export type Account = z.infer<typeof AccountSchema>;

export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    // Only structural paths are reported; validators can otherwise echo secret values or unknown keys.
    const paths = result.error.issues.map((i) => i.path.filter((p) => typeof p === "number" || /^[A-Za-z]+$/.test(String(p))).join(".") || "options");
    throw new IssueKeeperError("CONFIG_INVALID", `Configuración inválida en: ${[...new Set(paths)].join(", ")}.`);
  }
  return result.data;
}

export function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function downloadDirectory(config: Config, location: string): string {
  return safeRoot(config.attachments.downloadDir, location);
}

export function safeRoot(path: string, location: string): string {
  const target = resolve(location, path);
  if (!within(location, target) || target === resolve(location)
    || relative(location, target).split(sep).some((part) => [".git", ".ssh", ".config", ".aws", ".env", "secrets", "node_modules"].includes(part))) {
    throw new IssueKeeperError("CONFIG_INVALID", "La raíz de archivos debe estar dentro de la ubicación, fuera de secretos y metadatos.");
  }
  return target;
}
