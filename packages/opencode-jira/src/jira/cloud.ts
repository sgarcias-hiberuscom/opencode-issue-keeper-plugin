import { z } from "zod";
import type { Account, Config } from "../config.js";
import { readFields } from "../config.js";
import { IssueKeeperError, invalidResponse } from "../errors.js";
import { apiUrl, HttpClient } from "../http.js";
import type { ReadAccess, TicketProvider } from "../core/provider.js";
import { Cursors } from "../core/cursors.js";
import type { Attachment, Comment, Page, ReadResult, Ticket, User } from "../core/ticket.js";
import type { Attachments, Comments, Get, Search } from "../tools/schemas.js";
import { adfText } from "./adf.js";
import { IssueSchema, JsmAttachment, JsmComment, PlatformAttachment, PlatformComment, RequestSchema, UserSchema, jsmPage, parse } from "./schemas.js";

const user = (u: z.infer<typeof UserSchema>): User => ({ id: u.accountId, ...(u.displayName === undefined ? {} : { displayName: u.displayName }) });
const requiredFields = ["project", "updated", "summary", "status"];

export class JiraCloud implements TicketProvider {
  private readonly cursors = new Cursors();
  constructor(private readonly config: Config, readonly http: HttpClient) {}
  close(): void { this.cursors.close(); this.http.close(); }

  async identity(account: Account, signal: AbortSignal): Promise<User> {
    return user(parse(UserSchema, await this.http.json(account, "rest/api/3/myself", signal)));
  }

  private fields(account: Account, requested?: string[]): string[] {
    const fields = requested ?? readFields.filter((field) => account.allowedReadFields.includes(field));
    if (fields.some((field) => !account.allowedReadFields.includes(field))) throw new IssueKeeperError("FORBIDDEN", "Campo de lectura no autorizado.");
    return [...new Set([...requiredFields, ...fields])].sort();
  }

  private project(account: Account, key: string): void {
    if (!account.allowedProjects.includes(key)) throw new IssueKeeperError("FORBIDDEN", "El proyecto real del recurso no está autorizado para esta cuenta.");
  }

  private normalize(account: Account, raw: z.infer<typeof IssueSchema>, fields: string[]): ReadResult<Ticket> {
    this.project(account, raw.fields.project.key);
    const description = adfText(fields.includes("description") ? raw.fields.description : null);
    return {
      data: {
        provider: "jira-cloud", account: account.id, id: raw.id, key: raw.key,
        url: `${account.siteUrl}/browse/${encodeURIComponent(raw.key)}`, project: raw.fields.project,
        summary: raw.fields.summary, status: raw.fields.status, updated: raw.fields.updated,
        fetchedAt: new Date().toISOString(), source: "platform",
        ...(fields.includes("description") ? { descriptionText: description.text } : {}),
        ...(fields.includes("assignee") && raw.fields.assignee !== undefined ? { assignee: raw.fields.assignee === null ? null : user(raw.fields.assignee) } : {}),
        ...(fields.includes("reporter") && raw.fields.reporter ? { reporter: user(raw.fields.reporter) } : {}),
        ...(fields.includes("labels") && raw.fields.labels ? { labels: raw.fields.labels } : {}),
        customFields: Object.fromEntries(fields.filter((f) => !readFields.includes(f) || ["priority", "issuetype"].includes(f)).filter((f) => raw.fields[f] !== undefined).map((f) => [f, raw.fields[f]])),
      },
      warnings: description.warnings,
    };
  }

  private async request(account: Account, issueKey: string, signal: AbortSignal) {
    if (!account.serviceManagement.enabled) return undefined;
    try {
      return parse(RequestSchema, await this.http.json(account, `rest/servicedeskapi/request/${issueKey}?expand=serviceDesk`, signal));
    } catch (error) {
      if (error instanceof IssueKeeperError && error.code === "NOT_FOUND_OR_NO_ACCESS") return undefined;
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
      await authorize?.(request.issueKey);
      const description = request.requestFieldValues?.find((f) => f.fieldId === "description")?.value;
      return {
        data: {
          provider: "jira-cloud", account: account.id, id: request.issueId, key: request.issueKey,
          url: `${account.siteUrl}/browse/${encodeURIComponent(request.issueKey)}`,
          project: { id: request.serviceDesk.projectId, key: request.serviceDesk.projectKey },
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
    await authorize?.(result.data.key);
    const request = await this.request(account, result.data.key, signal);
    if (request) {
      if (request.issueId !== result.data.id || request.issueKey !== result.data.key) invalidResponse();
      result.data.serviceRequest = { serviceDeskId: request.serviceDeskId, requestTypeId: request.requestTypeId };
    } else if (account.serviceManagement.enabled) {
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
    this.project(account, input.project);
    const fields = this.fields(account, input.fields);
    const size = this.size(input.maxResults);
    const clauses = [`project = ${JSON.stringify(input.project)}`];
    if (input.assignee) clauses.push(input.assignee === "me" ? "assignee = currentUser()" : "assignee IS EMPTY");
    if (input.statusCategory) clauses.push(input.statusCategory === "notDone" ? "statusCategory != Done" : `statusCategory = ${JSON.stringify(input.statusCategory)}`);
    if (input.updatedSince) clauses.push(`updated >= ${JSON.stringify(input.updatedSince)}`);
    const jql = `${clauses.join(" AND ")} ORDER BY updated DESC, key ASC`;
    const scope = this.cursors.scope(["search", account.id, account.siteUrl, jql, fields, size]);
    const previous = this.cursors.get(input.cursor, scope);
    const raw = parse(z.object({ issues: z.array(IssueSchema), nextPageToken: z.string().min(1).max(10000).optional(), isLast: z.boolean().optional() }),
      await this.http.json(account, "rest/api/3/search/jql", signal, {
        jql, fields, maxResults: size, ...(previous ? { nextPageToken: previous.position } : {}),
      }));
    if (raw.issues.length > size) invalidResponse();
    const results = raw.issues.map((issue) => this.normalize(account, issue, fields));
    const isLast = raw.isLast === true || !raw.nextPageToken;
    return {
      data: { values: results.map((r) => r.data), isLast, cursor: this.cursors.next(scope, isLast ? undefined : raw.nextPageToken, previous) },
      warnings: [...new Set(results.flatMap((r) => r.warnings))],
    };
  }

  async comments(account: Account, input: Comments, signal: AbortSignal, authorize?: ReadAccess): Promise<ReadResult<Page<Comment>>> {
    const ticket = await this.get(account, { account: input.account, issueKey: input.issueKey, fields: [] }, signal, authorize);
    const jsm = Boolean(ticket.data.serviceRequest);
    if ((!jsm && input.audience && input.audience !== "ticket") || (jsm && input.audience === "ticket")) {
      throw new IssueKeeperError("CAPABILITY_NOT_SUPPORTED", "Audiencia incompatible; las solicitudes JSM usan exclusivamente comentarios JSM.");
    }
    if (account.serviceManagement.enabled && !jsm) throw new IssueKeeperError("CAPABILITY_NOT_SUPPORTED", "No se ha confirmado JSM; no se recurrirá a Platform para eludir visibilidad. Use un perfil Platform explícito si corresponde.");
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
        warnings: [...ticket.warnings, "Sólo se devuelven comentarios visibles; una lista vacía no demuestra ausencia de notas internas."],
      };
    }
    const raw = parse(z.object({ startAt: z.number().int(), maxResults: z.number().int().positive(), total: z.number().int().nonnegative(), comments: z.array(PlatformComment) }),
      await this.http.json(account, `rest/api/3/issue/${ticket.data.key}/comment?startAt=${start}&maxResults=${size}`, signal));
    if (raw.startAt !== start || raw.comments.length > size || (!raw.comments.length && start < raw.total)) invalidResponse();
    const texts = raw.comments.map((c) => adfText(c.body));
    const next = start + raw.comments.length;
    return {
      data: { values: raw.comments.map((c, i) => ({ id: c.id, text: texts[i]!.text, audience: "ticket", ...(c.author ? { author: user(c.author) } : {}), created: c.created, visibility: c.visibility })), isLast: next >= raw.total, cursor: this.cursors.next(scope, next >= raw.total ? undefined : next, previous) },
      warnings: [...ticket.warnings, ...texts.flatMap((t) => t.warnings)],
    };
  }

  private checkPage(page: { start: number; size: number; values: unknown[]; isLastPage: boolean }, start: number, size: number): void {
    if (page.start !== start || page.size !== page.values.length || page.values.length > size || (!page.isLastPage && !page.size)) invalidResponse();
  }

  download<T>(account: Account, ticket: Ticket, attachment: Attachment, signal: AbortSignal, consume: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
    const path = ticket.serviceRequest
      ? `rest/servicedeskapi/request/${ticket.key}/attachment/${attachment.id}`
      : `rest/api/3/attachment/content/${attachment.id}?redirect=false`;
    return this.http.read(account, path, signal, consume, undefined, true);
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
        // Extract the ID only. Never follow response links or return signed content URLs.
        let link: URL;
        try { link = new URL(attachment._links.jiraRest); } catch { invalidResponse(); }
        const match = /\/rest\/api\/[23]\/attachment\/([1-9][0-9]*)$/.exec(link.pathname);
        const root = apiUrl(account, "rest/api/3/myself");
        const prefix = root.pathname.replace(/rest\/api\/3\/myself$/, "");
        const direct = link.origin === account.siteUrl && /^\/rest\/api\/[23]\/attachment\/[1-9][0-9]*$/.test(link.pathname);
        const gateway = link.origin === root.origin && link.pathname.startsWith(prefix)
          && /^rest\/api\/[23]\/attachment\/[1-9][0-9]*$/.test(link.pathname.slice(prefix.length));
        if ((!direct && !gateway) || link.username || link.password || link.search || link.hash || !match) invalidResponse();
        return { id: match[1]!, filename: attachment.filename, size: attachment.size, mimeType: attachment.mimeType, audience: "unknown" };
      });
      return { data: { values, isLast: raw.isLastPage, cursor: this.cursors.next(scope, raw.isLastPage ? undefined : start + raw.size, previous) }, warnings: [...ticket.warnings, "JSM filtra por identidad; la API de adjuntos no declara su audiencia. Se conserva unknown."] };
    }
    if (account.serviceManagement.enabled) throw new IssueKeeperError("CAPABILITY_NOT_SUPPORTED", "No se ha confirmado JSM; no se listarán adjuntos por otra API.");
    const raw = parse(z.object({ id: z.string(), fields: z.object({ project: IssueSchema.shape.fields.shape.project, attachment: z.array(PlatformAttachment) }) }),
      await this.http.json(account, `rest/api/3/issue/${ticket.data.key}?fields=attachment,project`, signal));
    this.project(account, raw.fields.project.key);
    if (raw.id !== ticket.data.id) invalidResponse();
    const values = raw.fields.attachment.slice(start, start + size).map((a): Attachment => ({ ...a, audience: "unknown" }));
    const isLast = start + values.length >= raw.fields.attachment.length;
    return { data: { values, isLast, cursor: this.cursors.next(scope, isLast ? undefined : start + values.length, previous) }, warnings: ticket.warnings };
  }
}
