import { realpath } from "node:fs/promises";
import type { Account, Config } from "../config.js";
import { downloadDirectory, safeRoot } from "../config.js";
import { authorization } from "../credentials.js";
import { IssueKeeperError } from "../errors.js";
import { planDownload, saveDownload, type DownloadPlan } from "../files.js";
import type { Download, Get, Search, Comments, Attachments, Mentions } from "./inputs.js";
import type { ReadAccess, TicketProvider } from "./provider.js";
import { checkProject } from "./policy.js";
import { recordWarnings } from "./operation.js";
import type { Attachment, DownloadReceipt, ReadResult } from "./ticket.js";

export interface DownloadAccess {
  read: ReadAccess;
  local: (plan: DownloadPlan, canonicalKey: string) => Promise<void>;
}

export class Service {
  readonly directory: string;
  private readonly status = new Map<string, "unchecked" | "available" | "unavailable">();
  private constructor(readonly config: Config, readonly location: string, readonly provider: TicketProvider) {
    this.directory = downloadDirectory(config, location);
    config.attachments.uploadRoots.forEach((root) => safeRoot(root, location));
  }
  static async create(config: Config, location: string, provider: TicketProvider): Promise<Service> {
    return new Service(config, await realpath(location), provider);
  }
  account(id: string): Account {
    const account = this.config.accounts.find((a) => a.id === id);
    if (!account) throw new IssueKeeperError("ACCOUNT_UNAVAILABLE", this.config.accounts.length
      ? "El alias no está configurado; liste las cuentas. No se probará otro alias."
      : "No hay cuentas configuradas; añada una desde account.example.jsonc sin compartir el token en el chat.");
    return account;
  }
  close(): void { this.provider.close(); }

  async accounts() {
    return Promise.all(this.config.accounts.map(async (account) => {
      let state = this.status.get(account.id) ?? "unchecked";
      try { await authorization(account); }
      catch { state = "unavailable"; }
      return {
        account: account.id, label: account.label ?? account.id, site: account.siteUrl,
        default: account.id === this.config.defaultAccount,
        readOnly: account.readOnly, state, restrictedProjects: account.restrictedProjects,
        capabilities: { ...this.provider.capabilities, read: true, serviceManagement: this.provider.capabilities.serviceManagement && account.serviceManagement.enabled, download: this.provider.capabilities.download && this.config.attachments.enabled && process.platform === "linux" },
      };
    }));
  }

  async connection(id: string, signal: AbortSignal) {
    const account = this.account(id);
    try {
      await this.provider.tenant?.(account, signal);
      const identity = await this.provider.identity(account, signal);
      const serviceManagement = await this.provider.serviceManagementStatus?.(account, signal) ?? "not-tested";
      this.status.set(id, "available");
      return { identity, connected: true, site: account.siteUrl, serviceManagement, projectAccess: "not-tested" };
    } catch (error) {
      if (error instanceof IssueKeeperError && ["AUTH_FAILED", "ACCOUNT_UNAVAILABLE"].includes(error.code)) this.status.set(id, "unavailable");
      throw error;
    }
  }

  failed(id: string, error: unknown): void {
    if (error instanceof IssueKeeperError && ["AUTH_FAILED", "ACCOUNT_UNAVAILABLE"].includes(error.code)) this.status.set(id, "unavailable");
  }
  private access(account: Account, authorize?: ReadAccess): ReadAccess {
    return async (key, project) => { if (project) checkProject(account, project); await authorize?.(key); };
  }
  async get(input: Get, signal: AbortSignal, authorize?: ReadAccess) {
    const account = this.account(input.account);
    const result = await this.provider.get(account, input, signal, this.access(account, authorize));
    checkProject(account, result.data.project.key);
    recordWarnings(result.warnings);
    return result;
  }
  async search(input: Search, signal: AbortSignal) {
    const account = this.account(input.account);
    const result = await this.provider.search(account, input, signal);
    const values = result.data.values.filter((ticket) => !account.restrictedProjects.includes(ticket.project.key));
    if (values.length !== result.data.values.length) result.warnings.push("Se han omitido resultados de proyectos restringidos.");
    return { ...result, data: { ...result.data, values } };
  }
  async comments(input: Comments, signal: AbortSignal, authorize?: ReadAccess) {
    const account = this.account(input.account);
    await this.get({ account: input.account, issueKey: input.issueKey, fields: [] }, signal, authorize);
    return this.provider.comments(account, input, signal, this.access(account, authorize));
  }
  async attachments(input: Attachments, signal: AbortSignal, authorize?: ReadAccess) {
    const account = this.account(input.account);
    await this.get({ account: input.account, issueKey: input.issueKey, fields: [] }, signal, authorize);
    return this.provider.attachments(account, input, signal, this.access(account, authorize));
  }
  async mentionCandidates(input: Mentions, signal: AbortSignal, authorize?: ReadAccess) {
    const account = this.account(input.account);
    await this.get({ account: input.account, issueKey: input.issueKey, fields: [] }, signal, authorize);
    return this.provider.mentionCandidates(account, input, signal, this.access(account, authorize));
  }

  async download(input: Download, signal: AbortSignal, access: DownloadAccess): Promise<ReadResult<DownloadReceipt>> {
    const account = this.account(input.account);
    if (!this.config.attachments.enabled) throw new IssueKeeperError("CAPABILITY_NOT_SUPPORTED", "Transferencias deshabilitadas.");
    const ticket = await this.get({ account: account.id, issueKey: input.issueKey, fields: [] }, signal, access.read);
    let attachment: Attachment | undefined;
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.provider.attachments(account, { account: account.id, issueKey: ticket.data.key, maxResults: this.config.output.maxPageSize, cursor }, signal, this.access(account, access.read));
      recordWarnings(result.warnings);
      attachment = result.data.values.find((a) => a.id === input.attachmentId);
      if (attachment || result.data.isLast) break;
      cursor = result.data.cursor;
      if (!cursor) break;
    }
    if (!attachment) throw new IssueKeeperError("NOT_FOUND_OR_NO_ACCESS", "Adjunto no visible en este ticket o presupuesto de listado agotado; no se descargará por ID global.");
    if (!ticket.data.serviceRequest) await this.provider.attachmentMetadata(account, attachment, signal);
    if (attachment.size > this.config.attachments.maxFileBytes) throw new IssueKeeperError("ATTACHMENT_TOO_LARGE", "El adjunto excede el máximo configurado.");
    const plan = planDownload(this.directory, attachment.filename, attachment.id, input.destinationName);
    await access.local(plan, ticket.data.key);
    const receipt = await this.provider.download(account, ticket.data, attachment, signal,
      (response, combined) => saveDownload(response, plan, this.location, attachment.size, this.config.attachments.maxFileBytes, combined));
    return {
      data: receipt,
      warnings: [...ticket.warnings, "Fichero guardado en el servidor; no se ha abierto ni añadido al contexto del modelo."],
    };
  }
}
