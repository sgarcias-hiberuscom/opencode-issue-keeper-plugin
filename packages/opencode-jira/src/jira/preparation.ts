import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import type { Config, Account } from "../config.js";
import { checkProject } from "../core/policy.js";
import { changePolicyFingerprint } from "../core/change-policy.js";
import { normalizeMetadata, offeredFields, validateFieldChanges } from "../core/metadata.js";
import { publication } from "../core/comment.js";
import type { ChangePlan, JsonValue } from "../core/proposals.js";
import type { ReadAccess } from "../core/provider.js";
import type { CredentialLease } from "../credentials.js";
import { cancellation, invalidResponse, IssueKeeperError } from "../errors.js";
import type { HttpClient } from "../http.js";
import type { ChangeContext } from "../state/application.js";
import { stageUploadFiles } from "../state/staging.js";
import type { ChangeStore } from "../state/store.js";
import * as schemas from "../tools/change-schemas.js";
import { AudienceValidator } from "./audience.js";
import { ChangeIssue, finalFields, same } from "./changes.js";

type Update = z.infer<typeof schemas.UpdatePrepareInput>;
type Transition = z.infer<typeof schemas.TransitionPrepareInput>;
type Comment = z.infer<typeof schemas.CommentPrepareInput>;
type Upload = z.infer<typeof schemas.UploadPrepareInput>;
export type PrepareInput = Update | Transition | Comment | Upload;
function parse<T>(schema: z.ZodType<T>, raw: unknown): T { const result = schema.safeParse(raw); if (!result.success) invalidResponse(); return result.data; }
const Transitions = z.looseObject({ transitions: z.array(z.looseObject({ id: z.string().regex(/^[A-Za-z0-9_-]+$/), name: z.string(), to: z.looseObject({ id: z.string(), name: z.string() }), fields: z.record(z.string(), z.json()) })).max(1000) });

export class JiraPreparation {
  private readonly audience: AudienceValidator;
  constructor(private readonly config: Config, private readonly http: HttpClient, private readonly location: string, private readonly read: ReadAccess) { this.audience = new AudienceValidator(http); }

  private async snapshot(input: { account: string; issueKey: string }, context: ChangeContext, write: boolean, fields: string[] = []) {
    const account = this.config.accounts.find((account) => account.id === input.account);
    if (!account) throw new IssueKeeperError("ACCOUNT_UNAVAILABLE", "Cuenta no disponible.");
    if (write && account.readOnly) throw new IssueKeeperError("FORBIDDEN", "La cuenta es de sólo lectura.");
    await context.resolve(); cancellation(context.signal);
    await this.read(input.issueKey);
    if (account.auth.mode === "cloud-scoped-token") {
      const tenant = parse(z.looseObject({ cloudId: z.string() }), await this.http.tenant(account, context.signal));
      if (tenant.cloudId !== account.auth.cloudId) throw new IssueKeeperError("CONFIG_INVALID", "El cloudId no corresponde al sitio.");
    }
    const credential = await this.http.identityForWrite(account, context.signal);
    const issue = parse(ChangeIssue, await this.http.jsonBound(account, `rest/api/3/issue/${input.issueKey}?fields=${[...new Set(["updated", "project", "status", ...fields])].join(",")}`, credential, context.signal));
    checkProject(account, issue.fields.project.key); await this.read(issue.key, issue.fields.project.key);
    return { account, credential, issue };
  }
  async metadata(input: { account: string; issueKey: string }, context: ChangeContext, transitions = false) {
    const { account, credential, issue } = await this.snapshot(input, context, false);
    const raw = await this.http.jsonBound(account, `rest/api/3/issue/${issue.key}/${transitions ? "transitions?expand=transitions.fields" : "editmeta"}`, credential, context.signal);
    return { issueKey: issue.key, issueId: issue.id, updated: issue.fields.updated, ...(transitions ? { transitions: parse(Transitions, raw).transitions.map((transition) => ({ id: transition.id, name: transition.name, to: transition.to, fields: offeredFields(normalizeMetadata({ fields: transition.fields }), account.restrictedUpdateFields, true) })) } : { fields: offeredFields(normalizeMetadata(raw), account.restrictedUpdateFields) }), warnings: ["La metadata no garantiza aceptación definitiva por Jira."] };
  }

  async prepare(kind: "fields" | "transition" | "comment" | "upload", input: PrepareInput, store: ChangeStore, context: ChangeContext, authorizeLocal: (path: string) => Promise<void>): Promise<ChangePlan> {
    const requested = "fields" in input || "update" in input ? [...Object.keys((input as Update).fields ?? {}), ...Object.keys((input as Update).update ?? {})] : [];
    const { account, credential, issue } = await this.snapshot(input, context, true, requested);
    if (Date.parse(issue.fields.updated) !== Date.parse(input.expectedUpdated)) throw new IssueKeeperError("CONFLICT", "La fecha real del ticket cambió; consulte de nuevo antes de preparar.");
    const scope = await context.resolve();
    const now = new Date();
    const plan: ChangePlan = { version: 1, id: randomUUID(), sessionID: scope.sessionID, locationID: scope.locationID, account: account.id, site: account.siteUrl, credentialIdentity: credential.identity, issueId: issue.id, issueKey: issue.key, projectKey: issue.fields.project.key, kind, expectedUpdated: issue.fields.updated, policyFingerprint: changePolicyFingerprint(this.config, account), createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + this.config.changes.ttlSeconds * 1000).toISOString(), files: [], steps: [{ id: "mutation", kind: "mutation", fileRefs: [] }], payload: {}, summary: `${kind}: ${issue.key}` };
    if (kind === "fields" || kind === "transition") {
      let raw = kind === "fields" ? await this.http.jsonBound(account, `rest/api/3/issue/${issue.key}/editmeta`, credential, context.signal) : undefined;
      let statusId: string | undefined;
      if (kind === "transition") {
        const transitions = parse(Transitions, await this.http.jsonBound(account, `rest/api/3/issue/${issue.key}/transitions?expand=transitions.fields`, credential, context.signal));
        const target = transitions.transitions.find((item) => item.id === (input as Transition).transitionId);
        if (!target) throw new IssueKeeperError("CONFLICT", "La transición no está disponible.");
        raw = { fields: target.fields }; statusId = target.to.id;
      }
      const metadata = normalizeMetadata(raw);
      let existing = issue.fields as Record<string, JsonValue>;
      if (kind === "transition" && metadata.some((field) => field.required && !Object.hasOwn(existing, field.id))) {
        const fresh = parse(ChangeIssue, await this.http.jsonBound(account, `rest/api/3/issue/${issue.key}?fields=${[...new Set(["updated", "project", "status", ...requested, ...metadata.filter((field) => field.required).map((field) => field.id)])].join(",")}`, credential, context.signal));
        if (fresh.id !== issue.id || fresh.key !== issue.key || !same(fresh.fields.project, issue.fields.project) || Date.parse(fresh.fields.updated) !== Date.parse(issue.fields.updated)) throw new IssueKeeperError("CONFLICT", "El ticket cambió al resolver requisitos.");
        existing = fresh.fields as Record<string, JsonValue>;
      }
      const changes = await validateFieldChanges({ ...((input as Update).fields ? { fields: (input as Update).fields } : {}), ...(kind === "fields" && (input as Update).update ? { update: (input as Update).update } : {}) }, metadata, { restricted: account.restrictedUpdateFields, transition: kind === "transition", existing, validatePerson: async (id, field) => { if (field === "assignee") await this.audience.assignable(account, issue.key, id, credential, context.signal); else await this.audience.person(account, { issueKey: issue.key, projectKey: issue.fields.project.key }, id, "ticket", undefined, credential, context.signal); } });
      plan.payload = { request: { kind, issueKey: issue.key, ...changes, ...(kind === "transition" ? { transitionId: (input as Transition).transitionId } : {}) }, expectedFields: finalFields(changes, existing), previousFields: Object.fromEntries([...new Set([...Object.keys(changes.fields ?? {}), ...Object.keys(changes.update ?? {})])].map((field) => [field, existing[field] ?? null])), ...(statusId ? { expectedStatusId: statusId } : {}), warnings: requested.some((field) => metadata.find((item) => item.id === field)?.type === "adf") ? ["Sustitución completa de documento ADF; no se reconstruye desde texto leído."] : [] };
      return plan;
    }
    const content = input as Comment & Upload;
    plan.audience = content.audience;
    let remote: { serviceDeskId: string; reporter: { accountId: string } } | undefined;
    if (content.audience !== "ticket") {
      if (!account.serviceManagement.enabled) throw new IssueKeeperError("FORBIDDEN", "La cuenta no admite JSM.");
      const request = parse(z.looseObject({ issueId: z.string(), serviceDeskId: z.string().regex(/^\d+$/), reporter: z.looseObject({ accountId: z.string() }) }), await this.http.jsonBound(account, `rest/servicedeskapi/request/${issue.key}`, credential, context.signal));
      if (request.issueId !== issue.id) invalidResponse(); remote = request;
    }
    const source = kind === "comment" ? content.text : content.comment;
    let converted: ReturnType<typeof publication> | undefined;
    if (source !== undefined) {
      plan.commentText = source; plan.commentFormat = content.format ?? "plain"; plan.mentions = [];
      for (const mention of content.mentions ?? []) {
        const person = await this.audience.mention(account, { issueKey: issue.key, projectKey: issue.fields.project.key, ...(remote ? { serviceDeskId: remote.serviceDeskId, reporterId: remote.reporter.accountId } : {}) }, mention.accountId, content.audience, content.visibility, credential, context.signal);
        plan.mentions.push({ ...mention, displayName: person.displayName ?? person.accountId });
      }
      converted = publication(source, plan.commentFormat, plan.mentions, remote ? "jsm" : "platform");
    }
    if (kind === "comment") {
      const visibility = content.visibility ? await this.audience.visibility(account, content.visibility, credential, context.signal) : undefined;
      plan.payload = { request: remote ? { kind: "jsm-comment", issueKey: issue.key, body: converted!.wiki, public: content.audience === "public" } : { kind: "platform-comment", issueKey: issue.key, body: converted!.adf, ...(visibility ? { visibility } : {}) }, publication: converted as unknown as JsonValue };
    } else {
      if (!this.config.attachments.enabled) throw new IssueKeeperError("FORBIDDEN", "Las cargas están deshabilitadas.");
      const settings = parse(z.looseObject({ enabled: z.boolean(), uploadLimit: z.number().int().positive() }), await this.http.jsonBound(account, "rest/api/3/attachment/meta", credential, context.signal));
      if (!settings.enabled) throw new IssueKeeperError("FORBIDDEN", "El sitio no permite cargas.");
      const { maxBatchBytes, maxFilesPerUpload, transferTimeoutMs } = this.config.attachments;
      const limits = { maxBatchBytes, maxFilesPerUpload, transferTimeoutMs, maxFileBytes: Math.min(this.config.attachments.maxFileBytes, settings.uploadLimit) };
      const inputs = content.files.map((file) => ({ path: file.path, publishedName: file.publishedName ?? basename(file.path) }));
      if (inputs.some((file) => file.publishedName.includes('"') || remote && /[\[\]{}|]/.test(file.publishedName))) throw new IssueKeeperError("VALIDATION_FAILED", "Nombre de publicación incompatible con el destino; indique publishedName seguro sin cambiar el origen.");
      plan.files = await stageUploadFiles(store, inputs, { location: this.location, uploadRoots: this.config.attachments.uploadRoots, deniedPaths: this.config.accounts.flatMap((account) => account.auth.tokenFile ? [account.auth.tokenFile] : []), signal: context.signal, authorizeRead: authorizeLocal, revalidateContext: async () => { const current = await context.resolve(); if (current.sessionID !== plan.sessionID || current.locationID !== plan.locationID) throw new IssueKeeperError("CONFLICT", "Cambió el contexto de la carga."); }, limits });
      if (source !== undefined) plan.kind = "comment-with-attachments";
      plan.steps = plan.files.map((file, index) => ({ id: `file-${index + 1}`, kind: remote ? "temporary-upload" : "mutation", fileRefs: [file.stagedRef] }));
      if (remote) plan.steps.push({ id: "publish", kind: "publish-attachments", fileRefs: plan.files.map((file) => file.stagedRef) });
      plan.payload = { upload: { ...(remote ? { serviceDeskId: remote.serviceDeskId } : {}), ...(converted ? { additionalComment: { body: converted.wiki } } : {}) }, ...(converted ? { publication: converted as unknown as JsonValue } : {}) };
    }
    return plan;
  }
}
