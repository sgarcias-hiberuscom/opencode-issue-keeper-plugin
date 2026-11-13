import { realpath } from "node:fs/promises";
import type { Account, Config } from "../config.js";
import { downloadDirectory } from "../config.js";
import { authorization } from "../credentials.js";
import { IssueKeeperError } from "../errors.js";
import { planDownload, saveDownload, type DownloadPlan } from "../files.js";
import { HttpClient } from "../http.js";
import { JiraCloud } from "../jira/cloud.js";
import type { Download } from "../tools/schemas.js";
import type { ReadAccess } from "./provider.js";
import type { Attachment, DownloadReceipt, ReadResult } from "./ticket.js";

export interface DownloadAccess {
  read: ReadAccess;
  local: (plan: DownloadPlan, canonicalKey: string) => Promise<void>;
}

export class Service {
  readonly provider: JiraCloud;
  readonly directory: string;
  private readonly status = new Map<string, "unchecked" | "available" | "unavailable">();
  private constructor(readonly config: Config, readonly location: string, fetcher?: typeof fetch) {
    this.provider = new JiraCloud(config, new HttpClient(config, fetcher));
    this.directory = downloadDirectory(config, location);
  }
  static async create(config: Config, location: string, fetcher?: typeof fetch): Promise<Service> {
    return new Service(config, await realpath(location), fetcher);
  }
  account(id: string): Account {
    const account = this.config.accounts.find((a) => a.id === id);
    if (!account) throw new IssueKeeperError("ACCOUNT_UNAVAILABLE", "El alias no está configurado; liste las cuentas. No se probará otro alias.");
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
        default: account.id === (this.config.defaultAccount ?? (this.config.accounts.length === 1 ? account.id : undefined)),
        readOnly: account.readOnly, state, allowedProjects: account.allowedProjects,
        capabilities: { search: true, read: true, serviceManagement: account.serviceManagement.enabled, download: this.config.attachments.enabled && process.platform === "linux", remoteWrites: false },
      };
    }));
  }

  async connection(id: string, signal: AbortSignal) {
    const account = this.account(id);
    try {
      const identity = await this.provider.identity(account, signal);
      this.status.set(id, "available");
      return { identity, connected: true, site: account.siteUrl, serviceManagement: "not-tested", projectAccess: "not-tested" };
    } catch (error) {
      if (error instanceof IssueKeeperError && ["AUTH_FAILED", "ACCOUNT_UNAVAILABLE"].includes(error.code)) this.status.set(id, "unavailable");
      throw error;
    }
  }

  async download(input: Download, signal: AbortSignal, access: DownloadAccess): Promise<ReadResult<DownloadReceipt>> {
    const account = this.account(input.account);
    if (!this.config.attachments.enabled) throw new IssueKeeperError("CAPABILITY_NOT_SUPPORTED", "Transferencias deshabilitadas.");
    const ticket = await this.provider.get(account, { account: account.id, issueKey: input.issueKey, fields: [] }, signal, access.read);
    let attachment: Attachment | undefined;
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.provider.attachments(account, { account: account.id, issueKey: ticket.data.key, maxResults: this.config.output.maxPageSize, cursor }, signal, access.read);
      attachment = result.data.values.find((a) => a.id === input.attachmentId);
      if (attachment || result.data.isLast) break;
      cursor = result.data.cursor;
      if (!cursor) break;
    }
    if (!attachment) throw new IssueKeeperError("NOT_FOUND_OR_NO_ACCESS", "Adjunto no visible en este ticket o presupuesto de listado agotado; no se descargará por ID global.");
    if (attachment.size > this.config.attachments.maxFileBytes) throw new IssueKeeperError("ATTACHMENT_TOO_LARGE", "El adjunto excede el máximo configurado.");
    const plan = planDownload(this.directory, attachment.filename, attachment.id, input.destinationName);
    await access.local(plan, ticket.data.key);
    const receipt = await this.provider.download(account, ticket.data, attachment, signal,
      (response, combined) => saveDownload(response, plan, this.location, attachment.size, this.config.attachments.maxFileBytes, combined));
    return {
      data: { ...receipt, account: account.id, issueKey: ticket.data.key, attachmentId: attachment.id, audience: attachment.audience, location: "server" },
      warnings: [...ticket.warnings, "Fichero guardado en el servidor; no se ha abierto ni añadido al contexto del modelo."],
    };
  }
}
