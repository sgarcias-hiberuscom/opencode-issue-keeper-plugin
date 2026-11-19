import { z } from "zod";
import type { Account, Config } from "../config.js";
import { readFields } from "../config.js";
import { IssueKeeperError, invalidResponse } from "../errors.js";
import { HttpClient } from "../http.js";
import { attachmentLinkId } from "./attachment-links.js";
import type { ReadAccess, TicketProvider, BinaryConsumer } from "../core/provider.js";
import { Cursors } from "../core/cursors.js";
import { checkProject } from "../core/policy.js";
import { recordWarnings } from "../core/operation.js";
import type { Attachment, Comment, Page, ReadResult, Ticket, User, CandidatePage, DownloadReceipt } from "../core/ticket.js";
import type { Attachments, Comments, Get, Search, Mentions } from "../core/inputs.js";
import { restrictedJql } from "./jql.js";
import { mentionCandidates } from "./users.js";
import { adfText } from "./adf.js";
import { IssueSchema, JsmAttachment, JsmComment, PlatformAttachment, PlatformComment, RequestSchema, UserSchema, jsmPage, parse } from "./schemas.js";

const user = (u: z.infer<typeof UserSchema>): User => ({ id: u.accountId, ...(u.displayName === undefined ? {} : { displayName: u.displayName }) });
const requiredFields = ["project", "updated", "summary", "status"];

export class JiraCloud implements TicketProvider {
  readonly capabilities = { search: true, adf: true, serviceManagement: true, download: true, mentionCandidates: true, remoteWrites: true };
  private readonly cursors = new Cursors();
  constructor(private readonly config: Config, readonly http: HttpClient) {}
  close(): void { this.cursors.close(); this.http.close(); }

  async identity(account: Account, signal: AbortSignal): Promise<User> {
    return user(parse(UserSchema, await this.http.json(account, "rest/api/3/myself", signal)));
  }
  async tenant(account: Account, signal: AbortSignal): Promise<void> {
    if (account.auth.mode !== "cloud-scoped-token") return;
    const result = parse(z.object({ cloudId: z.string() }), await this.http.tenant(account, signal));
    if (result.cloudId !== account.auth.cloudId) throw new IssueKeeperError("CONFIG_INVALID", "El cloudId no corresponde al sitio configurado.");
  }
  async serviceManagementStatus(account: Account, signal: AbortSignal): Promise<"reachable" | "denied" | "not-tested"> {
    if (!account.serviceManagement.enabled) return "not-tested";
    try {
      parse(jsmPage(z.object({ id: z.string() })), await this.http.json(account, "rest/servicedeskapi/servicedesk?start=0&limit=1", signal));
      return "reachable";
    } catch (error) {
      if (error instanceof IssueKeeperError && ["FORBIDDEN", "NOT_FOUND_OR_NO_ACCESS"].includes(error.code)) return "denied";
      throw error;
    }
  }

  private fields(account: Account, requested?: string[]): string[] {
    const fields = requested ?? readFields;
    if (fields.length > 30 || fields.some((field) => !/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(field) || ["comment", "attachment", "worklog"].includes(field))) throw new IssueKeeperError("VALIDATION_FAILED", "Campos de lectura no válidos; use las operaciones específicas para comentarios y adjuntos.");
    return [...new Set([...requiredFields, ...fields])].sort();
  }

  private project(account: Account, key: string): void {
    checkProject(account, key);
  }

  private normalize(account: Account, raw: z.infer<typeof IssueSchema>, fields: string[]): ReadResult<Ticket> {
    this.project(account, raw.fields.project.key);
    const description = adfText(fields.includes("description") ? raw.fields.description : null);
    recordWarnings(description.warnings);
    return {
      data: {
        provider: "jira-cloud", account: account.id, id: raw.id, key: raw.key,
        url: `${account.siteUrl}/browse/${encodeURIComponent(raw.key)}`, project: raw.fields.project,
        summary: raw.fields.summary, status: raw.fields.status, updated: raw.fields.updated,
        fetchedAt: new Date().toISOString(), source: "platform",
        ...(fields.includes("description") ? { descriptionText: description.text, mentions: description.mentions } : {}),
        ...(fields.includes("assignee") && raw.fields.assignee !== undefined ? { assignee: raw.fields.assignee === null ? null : user(raw.fields.assignee) } : {}),
        ...(fields.includes("reporter") && raw.fields.reporter ? { reporter: user(raw.fields.reporter) } : {}),
        ...(fields.includes("labels") && raw.fields.labels ? { labels: raw.fields.labels } : {}),
        ...Object.fromEntries(["priority", "issuetype"].filter((f) => fields.includes(f) && raw.fields[f] != null).map((f) => [f, parse(z.object({ id: z.string(), name: z.string() }), raw.fields[f])])),
        customFields: Object.fromEntries(fields.filter((f) => !readFields.includes(f)).filter((f) => raw.fields[f] !== undefined).map((f) => [f, minimize(raw.fields[f])])),
      },
      warnings: description.warnings,
    };
  }

  private async request(account: Account, issueKey: string, signal: AbortSignal) {
    if (!account.serviceManagement.enabled) return undefined;
    try {
      return parse(RequestSchema, await this.http.json(account, `rest/servicedeskapi/request/${issueKey}?expand=serviceDesk`, signal));
    } catch (error) {
      if (error instanceof IssueKeeperError && ["FORBIDDEN", "NOT_FOUND_OR_NO_ACCESS"].includes(error.code)) return undefined;
      throw error;
    }
  }

  async get(account: Account, input: Get, signal: AbortSignal, authorize?: ReadAccess): Promise<ReadResult<Ticket>> {
    const fields = this.fields(account, input.fields);
    let raw: unknown;
    try {
      raw = await this.http.json(account, `rest/api/3/issue/${input.issueKey}?fields=${fields.join(",")}`, signal);
    } catch (error) {
      if (!account.serviceManagement.enabled || !(error instanceof IssueKeeperError)
        || !["FORBIDDEN", "NOT_FOUND_OR_NO_ACCESS"].includes(error.code)) throw error;
      // Portal-only customers need not have Jira Platform access. Validate the expanded service desk instead.
      const request = await this.request(account, input.issueKey, signal);
      if (!request?.serviceDesk) throw error;
      this.project(account, request.serviceDesk.projectKey);
      if (request.serviceDesk.id !== request.serviceDeskId) invalidResponse();
      await authorize?.(request.issueKey, request.serviceDesk.projectKey);
      const description = request.requestFieldValues?.find((f) => f.fieldId === "description")?.value;
      return {
        data: {
          provider: "jira-cloud", account: account.id, id: request.issueId, key: request.issueKey,
          url: `${account.siteUrl}/browse/${encodeURIComponent(request.issueKey)}`,
           project: { id: request.serviceDesk.projectId, key: request.serviceDesk.projectKey, projectTypeKey: "service_desk" },
          summary: request.summary, status: { name: request.currentStatus.status },
          source: "jsm-request", fetchedAt: new Date().toISOString(),
          ...(fields.includes("reporter") && request.reporter ? { reporter: user(request.reporter) } : {}),
          ...(fields.includes("description") && typeof description === "string" ? { descriptionText: description } : {}),
          serviceRequest: { serviceDeskId: request.serviceDeskId, requestTypeId: request.requestTypeId },
        },
        warnings: ["Lectura limitada al portal JSM; updated y campos Platform no disponibles. No se ha inferido una fecha de actualización."],
      };
    }
    const result = this.normalize(account, parse(IssueSchema, raw), fields);
    await authorize?.(result.data.key, result.data.project.key);
    const request = result.data.project.projectTypeKey === "software" || result.data.project.projectTypeKey === "business"
      ? undefined : await this.request(account, result.data.key, signal);
    if (request) {
      if (request.issueId !== result.data.id || request.issueKey !== result.data.key) invalidResponse();
      result.data.serviceRequest = { serviceDeskId: request.serviceDeskId, requestTypeId: request.requestTypeId };
      if (fields.includes("reporter") && request.reporter) result.data.reporter = user(request.reporter);
    } else if (account.serviceManagement.enabled && result.data.project.projectTypeKey !== "software" && result.data.project.projectTypeKey !== "business") {
      result.warnings.push("No se ha confirmado una solicitud JSM accesible; no equivale a demostrar que no existe.");
    }
    return result;
  }

  private size(input?: number): number {
    const size = input ?? this.config.output.pageSize;
    if (size > this.config.output.maxPageSize) throw new IssueKeeperError("VALIDATION_FAILED", "Página superior al máximo configurado.");
    return size;
  }

  async search(account: Account, input: Search, signal: AbortSignal): Promise<ReadResult<Page<Ticket>>> {
    const fields = this.fields(account, input.fields ?? ["summary", "status", "assignee", "project", "updated", "labels"]);
    const size = this.size(input.maxResults);
    const jql = restrictedJql(input.jql, account.restrictedProjects);
    const scope = this.cursors.scope(["search", account.id, account.siteUrl, jql, fields, size]);
    const previous = this.cursors.get(input.cursor, scope);
    const raw = parse(z.object({ issues: z.array(IssueSchema), nextPageToken: z.string().min(1).max(10000).optional(), isLast: z.boolean().optional() }),
      await this.http.json(account, "rest/api/3/search/jql", signal, {
        jql, fields, maxResults: size, ...(previous ? { nextPageToken: previous.position } : {}),
      }));
    if (raw.issues.length > size) invalidResponse();
    if (raw.isLast === false && !raw.nextPageToken || raw.isLast === true && raw.nextPageToken) invalidResponse();
    const allowed = raw.issues.filter((issue) => !account.restrictedProjects.includes(issue.fields.project.key));
    const omitted = allowed.length !== raw.issues.length;
    const results = allowed.map((issue) => this.normalize(account, issue, fields));
    const warnings = [...new Set([...results.flatMap((r) => r.warnings), ...(omitted ? ["Se han omitido resultados de proyectos restringidos; no se muestran sus datos."] : [])])];
    if (previous && results.length === 0) {
      warnings.push("La continuación no devolvió resultados. Si la página anterior anunciaba más, los datos pueden haber cambiado o la búsqueda puede estar incompleta: compruébalo con una búsqueda nueva.");
    }
    recordWarnings(warnings);
    const isLast = raw.isLast === true || !raw.nextPageToken;
    return {
      data: { values: results.map((r) => r.data), isLast, cursor: this.cursors.next(scope, isLast ? undefined : raw.nextPageToken, previous) },
      warnings,
    };
  }

  async comments(account: Account, input: Comments, signal: AbortSignal, authorize?: ReadAccess): Promise<ReadResult<Page<Comment>>> {
    const ticket = await this.get(account, { account: input.account, issueKey: input.issueKey, fields: [] }, signal, authorize);
    const jsm = Boolean(ticket.data.serviceRequest);
    if ((!jsm && input.audience && input.audience !== "ticket") || (jsm && input.audience === "ticket")) {
      throw new IssueKeeperError("CAPABILITY_NOT_SUPPORTED", "Audiencia incompatible; las solicitudes JSM usan exclusivamente comentarios JSM.");
    }
    if (account.serviceManagement.enabled && !jsm && ticket.data.project.projectTypeKey !== "software" && ticket.data.project.projectTypeKey !== "business") throw new IssueKeeperError("CAPABILITY_NOT_SUPPORTED", "No se ha confirmado JSM; no se recurrirá a Platform para eludir visibilidad.");
    const size = this.size(input.maxResults);
    const scope = this.cursors.scope(["comments", account.id, account.siteUrl, ticket.data.id, input.audience, size]);
    const previous = this.cursors.get(input.cursor, scope);
    const start = Number(previous?.position ?? 0);
    if (jsm) {
      const raw = parse(jsmPage(JsmComment), await this.http.json(account,
        `rest/servicedeskapi/request/${ticket.data.key}/comment?start=${start}&limit=${size}&public=${input.audience !== "internal"}&internal=${input.audience !== "public"}`, signal));
      this.checkPage(raw, start, size);
      if (raw.values.some((comment) => input.audience === "internal" ? comment.public : input.audience === "public" ? !comment.public : false)) invalidResponse();
      return {
        data: {
          values: raw.values.map((c) => ({ id: c.id, text: c.body, audience: c.public ? "public" : "internal", ...(c.author ? { author: user(c.author) } : {}), created: c.created?.iso8601 })),
          isLast: raw.isLastPage, cursor: this.cursors.next(scope, raw.isLastPage ? undefined : start + raw.size, previous),
        },
        warnings: [...ticket.warnings, "Sólo se devuelven comentarios visibles; una lista vacía no demuestra ausencia de notas internas.", "Las menciones del texto JSM no están verificadas; no se infieren identidades."],
      };
    }
    const raw = parse(z.object({ startAt: z.number().int(), maxResults: z.number().int().positive(), total: z.number().int().nonnegative(), comments: z.array(PlatformComment) }),
      await this.http.json(account, `rest/api/3/issue/${ticket.data.key}/comment?startAt=${start}&maxResults=${size}`, signal));
    if (raw.startAt !== start || raw.comments.length > size || raw.comments.length > raw.maxResults || start + raw.comments.length > raw.total || (!raw.comments.length && start < raw.total)) invalidResponse();
    const texts = raw.comments.map((c) => adfText(c.body));
    recordWarnings(texts.flatMap((text) => text.warnings));
    const next = start + raw.comments.length;
    return {
      data: { values: raw.comments.map((c, i) => ({ id: c.id, text: texts[i]!.text, mentions: texts[i]!.mentions, audience: c.jsdPublic === undefined ? "ticket" : c.jsdPublic ? "public" : "internal", ...(c.author ? { author: user(c.author) } : {}), created: c.created, visibility: c.visibility })), isLast: next >= raw.total, cursor: this.cursors.next(scope, next >= raw.total ? undefined : next, previous) },
      warnings: [...ticket.warnings, ...texts.flatMap((t) => t.warnings), ...(ticket.data.project.projectTypeKey === "service_desk" && raw.comments.some((c) => c.jsdPublic === undefined) ? ["La API Platform no declara la audiencia JSM de algunos comentarios."] : [])],
    };
  }

  private checkPage(page: { start: number; limit: number; size: number; values: unknown[]; isLastPage: boolean }, start: number, size: number): void {
    if (page.start !== start || page.size !== page.values.length || page.values.length > size || page.values.length > page.limit || (!page.isLastPage && !page.size)) invalidResponse();
  }

  async download(account: Account, ticket: Ticket, attachment: Attachment, signal: AbortSignal, consume: BinaryConsumer): Promise<DownloadReceipt> {
    const path = ticket.serviceRequest
      ? `rest/servicedeskapi/request/${ticket.key}/attachment/${attachment.id}`
      : `rest/api/3/attachment/content/${attachment.id}?redirect=false`;
    const receipt = await this.http.read(account, path, signal, consume, undefined, true);
    return {
      ...receipt, account: account.id, issueKey: ticket.key, attachmentId: attachment.id,
      audience: attachment.audience, location: "server", site: account.siteUrl,
      via: ticket.serviceRequest ? "jsm" : "platform", filename: attachment.filename, mimeType: attachment.mimeType,
    };
  }
  async attachmentMetadata(account: Account, attachment: Attachment, signal: AbortSignal): Promise<void> {
    const raw = parse(PlatformAttachment, await this.http.json(account, `rest/api/3/attachment/${attachment.id}`, signal));
    if (raw.id !== attachment.id || raw.filename !== attachment.filename || raw.size !== attachment.size || raw.mimeType !== attachment.mimeType) {
      throw new IssueKeeperError("TRANSFER_INCOMPLETE", "La metadata del adjunto cambió; vuelva a listarlo.");
    }
  }

  async mentionCandidates(account: Account, input: Mentions, signal: AbortSignal, authorize?: ReadAccess): Promise<ReadResult<CandidatePage>> {
    const ticket = await this.get(account, { account: input.account, issueKey: input.issueKey, fields: ["reporter"] }, signal, authorize);
    return mentionCandidates(this.http, this.cursors, this.config, account, input, ticket.data, signal, ticket.warnings);
  }

  async attachments(account: Account, input: Attachments, signal: AbortSignal, authorize?: ReadAccess): Promise<ReadResult<Page<Attachment>>> {
    if (!this.config.attachments.enabled) throw new IssueKeeperError("CAPABILITY_NOT_SUPPORTED", "Adjuntos deshabilitados por política local.");
    const ticket = await this.get(account, { account: input.account, issueKey: input.issueKey, fields: [] }, signal, authorize);
    const size = this.size(input.maxResults);
    const scope = this.cursors.scope(["attachments", account.id, account.siteUrl, ticket.data.id, size]);
    const previous = this.cursors.get(input.cursor, scope);
    const start = Number(previous?.position ?? 0);
    if (ticket.data.serviceRequest) {
      const raw = parse(jsmPage(JsmAttachment), await this.http.json(account,
        `rest/servicedeskapi/request/${ticket.data.key}/attachment?start=${start}&limit=${size}`, signal));
      this.checkPage(raw, start, size);
      const values = raw.values.map((attachment): Attachment => {
        return { id: attachmentLinkId(account, attachment._links.jiraRest), filename: attachment.filename, size: attachment.size, mimeType: attachment.mimeType, audience: "unknown", ...(attachment.author ? { author: user(attachment.author) } : {}), created: attachment.created };
      });
      return { data: { values, isLast: raw.isLastPage, cursor: this.cursors.next(scope, raw.isLastPage ? undefined : start + raw.size, previous) }, warnings: [...ticket.warnings, "JSM filtra por identidad; la API de adjuntos no declara su audiencia. Se conserva unknown."] };
    }
    if (account.serviceManagement.enabled && ticket.data.project.projectTypeKey !== "software" && ticket.data.project.projectTypeKey !== "business") throw new IssueKeeperError("CAPABILITY_NOT_SUPPORTED", "No se ha confirmado JSM; no se listarán adjuntos por otra API.");
    const raw = parse(z.object({ id: z.string(), fields: z.object({ project: IssueSchema.shape.fields.shape.project, attachment: z.array(PlatformAttachment) }) }),
      await this.http.json(account, `rest/api/3/issue/${ticket.data.key}?fields=attachment,project`, signal));
    this.project(account, raw.fields.project.key);
    if (raw.id !== ticket.data.id) invalidResponse();
    await authorize?.(ticket.data.key, raw.fields.project.key);
    const values = raw.fields.attachment.slice(start, start + size).map((a): Attachment => ({ ...a, author: a.author ? user(a.author) : undefined, audience: "unknown" }));
    const isLast = start + values.length >= raw.fields.attachment.length;
    return { data: { values, isLast, cursor: this.cursors.next(scope, isLast ? undefined : start + values.length, previous) }, warnings: ticket.warnings };
  }
}

function minimize(value: unknown): unknown {
  let nodes = 0;
  function visit(child: unknown, depth: number): unknown {
    if (depth > 50 || ++nodes > 20000) throw new IssueKeeperError("RESPONSE_TOO_LARGE", "Campo personalizado demasiado complejo; reduzca los campos solicitados.");
    if (Array.isArray(child)) return child.map((item) => visit(item, depth + 1));
    if (child && typeof child === "object") return Object.fromEntries(Object.entries(child)
      .filter(([key]) => !["emailAddress", "avatarUrls", "self"].includes(key))
      .map(([key, item]) => [key, visit(item, depth + 1)]));
    return child;
  }
  return visit(value, 0);
}
