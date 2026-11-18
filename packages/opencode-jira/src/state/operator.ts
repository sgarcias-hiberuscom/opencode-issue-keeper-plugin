import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig, type Config } from "../config.js";
import { HttpClient } from "../http.js";
import { IssueKeeperError } from "../errors.js";
import { httpError } from "../errors.js";
import { parseDocument } from "../installer/jsonc.js";
import { installerPaths } from "../installer/paths.js";
import { JiraChangeAdapter } from "../jira/changes.js";
import type { StoredChange } from "../core/proposals.js";
import { userDataDirectory } from "./paths.js";
import { readExecutionDigests } from "./store.js";
import { withChangeStore } from "./coordinator.js";

export function operatorSummary(saved: StoredChange) {
  const uncertain = saved.execution.steps.some((step) => ["sending", "unknown"].includes(step.state)) || saved.execution.state === "unknown" && Object.values(saved.receipts).some((receipt) => !receipt.verifiedAt);
  const partial = saved.plan.files.length > 0 && Object.keys(saved.receipts).length > 0 && saved.execution.state !== "applied" && saved.execution.steps.some((step) => ["pending", "failed"].includes(step.state));
  const error = uncertain || saved.execution.state === "unknown" && !partial
    ? { code: "WRITE_OUTCOME_UNKNOWN", retryable: false, message: "Resultado no completamente acreditado; no repita la mutación." }
    : partial ? { code: "PARTIAL_UPLOAD", retryable: false, message: "Se conserva progreso parcial por archivo/fase; no repita el lote. Sólo puede continuar un remanente acreditado y autorizado." } : undefined;
  return { proposalId: saved.plan.id, account: saved.plan.account, issueKey: saved.plan.issueKey, payloadHash: saved.payloadHash, state: saved.execution.state,
    ...(error ? { error } : {}),
    steps: saved.execution.steps.map((step) => ({ ...step, receipt: saved.receipts[step.id], ...(step.rejectionStatus ? { error: { code: step.rejectionStatus === 413 && saved.plan.files.length ? "ATTACHMENT_TOO_LARGE" : httpError(step.rejectionStatus).code, retryable: false } } : {}) })),
    guidance: saved.execution.state === "unknown" || saved.execution.state === "failed" && Object.keys(saved.receipts).length
      ? "No reenviar. verify sólo comprueba recibos confirmados; pasos inciertos sin recibo requieren evidencia remota y resolución del operador, no un reset." : "La consulta no autoriza ni envía cambios." };
}
export async function inspectProposal(proposalId: string, data?: string) {
  return withChangeStore((store) => operatorSummary(store.get(proposalId)), { data });
}

export interface ExecutionsSummary {
  states: Record<string, number>;
  uncertain: number;
  partial: number;
  oldestPendingAt: string | null;
}

export function summarizeExecutions(data?: string): ExecutionsSummary {
  const { states, executions } = readExecutionDigests(data ?? userDataDirectory());
  let uncertain = 0;
  let partial = 0;
  let oldest: number | undefined;
  for (const digest of executions) {
    const unverified = digest.receipts - digest.verifiedReceipts;
    if (digest.steps.some((state) => state === "sending" || state === "unknown")
      || digest.state === "unknown" && unverified > 0) uncertain++;
    if (digest.files > 0 && digest.receipts > 0 && digest.state !== "applied"
      && digest.steps.some((state) => state === "pending" || state === "failed")) partial++;
    if (["prepared", "applying", "unknown"].includes(digest.state)) {
      const at = Date.parse(digest.updatedAt);
      if (Number.isFinite(at) && (oldest === undefined || at < oldest)) oldest = at;
    }
  }
  return { states, uncertain, partial, oldestPendingAt: oldest === undefined ? null : new Date(oldest).toISOString() };
}

export async function installedConfiguration(): Promise<Config> {
  const paths = installerPaths();
  const documents = await Promise.all(["opencode.json", "opencode.jsonc"].map(async (name) => {
    try { return await readFile(join(paths.config, name), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }));
  const present = documents.filter((text) => text !== undefined);
  if (present.length !== 1) throw new IssueKeeperError("CONFIG_INVALID", "No hay una configuración global inequívoca para la comprobación.");
  const document = parseDocument(present[0]!);
  const plugins = Array.isArray(document.plugins) ? document.plugins : [];
  const matches = plugins.filter((plugin): plugin is { package: string; options: unknown } => Boolean(plugin && typeof plugin === "object" && "package" in plugin && typeof plugin.package === "string" && /(?:@issuekeeper\/opencode-jira|(?:^|\/)opencode-jira(?:\/|$)|issuekeeper\.jira)/.test(plugin.package)));
  if (matches.length !== 1) throw new IssueKeeperError("CONFIG_INVALID", "No hay una única instalación Jira configurada.");
  return parseConfig(matches[0]!.options);
}

export async function verifyRecorded(proposalId: string, config: Config, options: { data?: string; fetcher?: typeof fetch; signal?: AbortSignal; authorizeDownload?: (plan: StoredChange["plan"], attachmentId: string) => Promise<void> } = {}) {
  const signal = options.signal ?? new AbortController().signal;
  const http = new HttpClient(config, options.fetcher);
  const adapter = new JiraChangeAdapter(() => config, http, async () => {}, options);
  try {
    return await withChangeStore(async (store) => {
      let saved = store.get(proposalId);
      for (const step of saved.plan.steps) {
        const receipt = saved.receipts[step.id]; if (!receipt || receipt.verifiedAt) continue;
        const context = { sessionID: saved.plan.sessionID, signal, resolve: async () => ({ sessionID: saved.plan.sessionID, locationID: saved.plan.locationID }) };
        const current = await adapter.validate(saved.plan, context, "verify", saved);
        if (current.account !== saved.plan.account || current.site !== saved.plan.site || current.credentialIdentity !== saved.plan.credentialIdentity || current.issueId !== saved.plan.issueId || current.issueKey !== saved.plan.issueKey || current.projectKey !== saved.plan.projectKey) throw new IssueKeeperError("CONFLICT", "La identidad o destino no coincide con el recibo; no se modificará su verificación.");
         const verified = await adapter.verify(saved.plan, step, receipt, current.binding, context);
         if (verified) {
           signal.throwIfAborted(); saved = store.verified(proposalId, saved.execution.revision, step.id, undefined, typeof verified === "object" ? verified.updated : undefined);
        }
      }
      return operatorSummary(saved);
    }, { data: options.data, signal });
  } finally { http.close(); }
}
