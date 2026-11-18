import type { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Service } from "../core/service.js";
import { operations, type Operation } from "../core/operation.js";
import { resolveSessionScope } from "../core/scope.js";
import { Alias } from "../config.js";
import { applicationFailure, cancellation, IssueKeeperError, validationFailure } from "../errors.js";
import { StateError } from "../state/errors.js";
import { PlanValidationError } from "../core/proposals.js";

export type Context = Parameters<Plugin.Plugin["setup"]>[0];
export type Editor = Parameters<Parameters<Context["tool"]["transform"]>[0]>[0];
export type Execution = Parameters<Parameters<Editor["add"]>[0]["execute"]>[1];
export const refusal = "Si OpenCode deniega un permiso (Permission denied), termina esta petición sin más llamadas: tampoco accounts_list ni connection_test. No cambies de cuenta ni mecanismo; no es un fallo del token.";

export async function nativePermit(ctx: Context, context: Execution, action: string, resources: string[], metadata?: Record<string, string>, save = resources) {
  cancellation(context.signal);
  await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent, source: { type: "tool", messageID: context.messageID, id: context.id }, action, resources, save, ...(metadata === undefined ? {} : { metadata }) });
  cancellation(context.signal);
}

export function output(data: unknown, budget: number): { data: unknown; truncated: boolean } {
  let left = budget; let truncated = false;
  function visit(value: unknown, key = "", custom = false): unknown {
    custom ||= key === "customFields";
    if (typeof value === "string" && (custom || ["summary", "descriptionText", "text", "displayName", "label", "labels"].includes(key))) {
      const text = value.slice(0, left); left -= text.length;
      if (text.length !== value.length) { truncated = true; return `${text}…[truncado]`; }
      return text;
    }
    if (Array.isArray(value)) return value.map((v) => visit(v, key, custom));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v, k, custom)]));
    return value;
  }
  return { data: visit(data), get truncated() { return truncated; } };
}

function normalizedError(error: unknown): unknown {
  if (error instanceof PlanValidationError) return new IssueKeeperError("PROPOSAL_INVALID", "El plan no es válido o excede los límites.");
  if (!(error instanceof StateError)) return error;
  const code = error.reason === "EXPIRED" ? "PROPOSAL_EXPIRED" : error.reason === "NOT_FOUND" || error.reason === "INVALID" ? "PROPOSAL_INVALID" : error.reason === "BUSY" || error.reason === "CONFLICT" ? "CONFLICT" : "FORBIDDEN";
  return new IssueKeeperError(code, "El estado local impide esta operación. Consulte status; no repita una mutación incierta.");
}

export function toolRegistrar(editor: Editor, ctx: Context, service: Service, critical = false) {
  return function add<T extends z.ZodType>(name: string, description: string, schema: T, execute: (input: z.output<T>, context: Execution) => Promise<{ data: unknown; account?: string; warnings?: string[] }>) {
    editor.add({ name, description: `${description} ${refusal}`, input: z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }), options: { namespace: "jira" },
      execute: async (raw, context) => {
        const requestId = randomUUID(); const parsed = schema.safeParse(raw);
        const alias = Alias.safeParse(raw && typeof raw === "object" && "account" in raw ? raw.account : undefined);
        let account = alias.success ? alias.data : undefined;
        const operation: Operation = { requestId, tool: `jira_${name}`, account, operation: name, attempts: 0, warnings: [] };
        const started = Date.now(); let code = "OK"; let warnings: string[] = [];
        return operations.run(operation, async () => {
          try {
            cancellation(context.signal);
            if (!parsed.success) throw validationFailure(parsed.error.issues);
            await resolveSessionScope(() => ctx.session.get({ sessionID: context.sessionID }), service.location);
            cancellation(context.signal); if (account) service.account(account);
            const result = await execute(parsed.data, context); cancellation(context.signal);
            account ??= result.account;
            warnings = [...new Set([...operation.warnings, ...(result.warnings ?? [])])];
            const normalized = critical ? { data: result.data, truncated: false } : output(result.data, service.config.output.maxTextChars);
            if (Buffer.byteLength(JSON.stringify(normalized.data)) > (critical ? 256 * 1024 : service.config.output.maxTextChars * 4 + 32768)) throw new IssueKeeperError("RESPONSE_TOO_LARGE", "Salida demasiado grande; consulte una vista menor sin truncar recibos.");
            return { content: JSON.stringify({ ok: true, account, data: normalized.data, warnings: [...new Set([...warnings, ...(normalized.truncated ? ["Contenido truncado; consulte menos campos o una página menor."] : [])])], meta: { requestId, truncated: normalized.truncated, untrustedContent: true } }) };
          } catch (caught) {
            account ??= operation.account;
            const error = normalizedError(caught);
            code = error instanceof IssueKeeperError ? error.code : "NATIVE_FAILURE";
            if (account) service.failed(account, error);
            if (context.signal.aborted) throw context.signal.reason;
            if (!(error instanceof IssueKeeperError)) throw error;
            return { content: JSON.stringify(applicationFailure(error, requestId, account, [...new Set([...warnings, ...operation.warnings])])) };
          } finally { console.error(JSON.stringify({ requestId, tool: operation.tool, account, operation: name, status: operation.status, attempts: operation.attempts, code, durationMs: Date.now() - started })); }
        });
      },
    });
  };
}
