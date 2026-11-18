import { z } from "zod";
import { createHash } from "node:crypto";
import { Field, type Account, type Config } from "../config.js";
import type { CredentialLease } from "../credentials.js";
import { canonicalJSON, RemoteId, Timestamp, type ChangePlan, type JsonValue, type StepReceipt, type StoredChange } from "../core/proposals.js";
import { boundAuthorization } from "../credentials.js";
import { statePaths, userDataDirectory } from "../state/paths.js";
import { changePolicyFingerprint } from "../core/change-policy.js";
import { normalizeMetadata, validateFieldChanges } from "../core/metadata.js";
import { checkProject } from "../core/policy.js";
import type { ReadAccess } from "../core/provider.js";
import { IssueKeeperError, invalidResponse } from "../errors.js";
import type { HttpClient } from "../http.js";
import type { ChangeContext, ChangeValidation, StepOutcome } from "../state/application.js";
import { AudienceValidator } from "./audience.js";
import { MutationUncertainError, validateMutation, type JiraMutation } from "./mutations.js";
import { attachmentLinkId } from "./attachment-links.js";
import { adfText } from "./adf.js";
import { PlatformAttachment } from "./schemas.js";

export const PreparedPayload = z.strictObject({ request: z.json().optional(), upload: z.strictObject({ serviceDeskId: z.string().regex(/^\d+$/).optional(), additionalComment: z.strictObject({ body: z.string().min(1) }).optional() }).optional(), expectedFields: z.record(Field, z.json()).optional(), previousFields: z.record(Field, z.json()).optional(), expectedStatusId: RemoteId.optional(), publication: z.json().optional(), warnings: z.array(z.string()).optional() });
export const ChangeIssue = z.looseObject({ id: RemoteId, key: z.string().max(100).regex(/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/), fields: z.looseObject({ updated: Timestamp, project: z.looseObject({ key: z.string().max(100).regex(/^[A-Z][A-Z0-9_]*$/) }), status: z.looseObject({ id: RemoteId }) }) });
const Issue = ChangeIssue;
const SavedPublication = z.strictObject({ version: z.literal(1), adf: z.strictObject({ type: z.literal("doc"), version: z.literal(1), content: z.array(z.json()) }), wiki: z.string().min(1), readable: z.string() });
export interface JiraChangeBinding {
  account: Account; credential: CredentialLease; request?: JiraMutation; upload?: z.infer<typeof PreparedPayload>["upload"];
  expectedFields?: Record<string, JsonValue>; expectedStatusId?: string;
  baselineUpdated?: string;
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T { const result = schema.safeParse(input); if (!result.success) invalidResponse(); return result.data; }
function attachmentBodyMatches(body: string, source: string, names: string[]): boolean {
  if (!body.startsWith(source)) return false;
  const lines = body.slice(source.length).trim().split(/\r?\n/).filter(Boolean); const remaining = [...names];
  for (const line of lines) {
    const index = remaining.findIndex((name) => line.startsWith(`[^${name}] `) && /^_\([0-9]+(?:\.[0-9]+)?\s*(?:B|bytes?|kB|KB|MB|GB)\)_$/.test(line.slice(name.length + 4)));
    if (index < 0) return false; remaining.splice(index, 1);
  }
  return !remaining.length;
}
function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === "object") {
    if ("accountId" in value && typeof value.accountId === "string") return { accountId: value.accountId };
    if ("id" in value && typeof value.id === "string" && !("type" in value)) return { id: value.id };
  }
  return value;
}
export function same(left: unknown, right: unknown): boolean { try { return canonicalJSON(comparable(left)) === canonicalJSON(comparable(right)); } catch { return false; } }

export function sameField(field: string, left: unknown, right: unknown, previous?: unknown): boolean {
  if (["labels", "components", "fixVersions", "versions"].includes(field) && Array.isArray(left) && Array.isArray(right)) {
    const ordered = (values: unknown[]) => values.map((value) => canonicalJSON(comparable(value))).sort();
    try { return same(ordered(left), ordered(right)); } catch { return false; }
  }
  const isDocument = (value: unknown) => Boolean(value && typeof value === "object" && "type" in value && value.type === "doc");
  const adf = ["description", "environment"].includes(field) || isDocument(right) || isDocument(previous);
  if (adf && (left === null || right === null)) {
    const empty = { type: "doc", version: 1, content: [] };
    return left === null && right === null || sameADF(left === null ? right : left, empty);
  }
  if (left && typeof left === "object" && "type" in left && left.type === "doc") return sameADF(left, right);
  return same(left, right);
}

export function sameADF(left: unknown, right: unknown): boolean {
  function document(value: unknown, depth = 0): unknown {
    if (depth > 64) throw new Error("Document depth exceeded");
    if (Array.isArray(value)) return value.map((child) => document(child, depth + 1));
    if (!value || typeof value !== "object") return value;
    const node = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(node).filter(([key, child]) => !(key === "attrs" && child && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length === 0)).map(([key, child]) => {
      // Jira resolves mention labels and adds accessLevel; identity and position are semantic.
      if (node.type === "mention" && key === "attrs" && child && typeof child === "object" && !Array.isArray(child)) {
        return [key, Object.fromEntries(Object.entries(child).filter(([attr]) => !["text", "accessLevel"].includes(attr)))];
      }
      return [key, document(child, depth + 1)];
    }));
  }
  try { return same(document(left), document(right)); } catch { return false; }
}

export function sameVisibility(actual: unknown, expected: unknown): boolean {
  if (expected === undefined || expected === null) return actual === undefined || actual === null;
  const parsed = z.strictObject({ type: z.enum(["role", "group"]), value: z.string().min(1), identifier: z.string().min(1).optional() }).safeParse(actual);
  const intended = z.strictObject({ type: z.enum(["role", "group"]), value: z.string().min(1), identifier: z.string().min(1).optional() }).safeParse(expected);
  return parsed.success && intended.success && parsed.data.type === intended.data.type && parsed.data.value === intended.data.value
    && (intended.data.identifier === undefined || parsed.data.identifier === intended.data.identifier);
}

export function finalFields(request: { fields?: Record<string, JsonValue>; update?: Record<string, JsonValue> }, existing: Record<string, unknown>): Record<string, JsonValue> {
  const expected = structuredClone(request.fields ?? {});
  for (const [field, operations] of Object.entries(request.update ?? {})) {
    let current = existing[field];
    for (const operation of operations as Record<string, JsonValue>[]) {
      if (Object.hasOwn(operation, "set")) current = operation.set;
      else if (Object.hasOwn(operation, "add")) { if (!Array.isArray(current)) invalidResponse(); current = current.some((value) => same(value, operation.add)) ? current : [...current, operation.add]; }
      else if (Object.hasOwn(operation, "remove")) { if (!Array.isArray(current)) invalidResponse(); current = current.filter((value) => !same(value, operation.remove)); }
    }
    expected[field] = current as JsonValue;
  }
  return expected;
}

export class JiraChangeAdapter {
  private readonly audience: AudienceValidator;
  constructor(private readonly configuration: () => Config, private readonly http: HttpClient, private readonly authorizeRead: ReadAccess,
    private readonly options: { data?: string; authorizeDownload?: (plan: ChangePlan, attachmentId: string) => Promise<void> } = {}) { this.audience = new AudienceValidator(http); }

  async validate(plan: ChangePlan, context: ChangeContext, purpose: "apply" | "verify" = "apply", progress?: StoredChange): Promise<ChangeValidation<JiraChangeBinding>> {
    const config = this.configuration(); const account = config.accounts.find((account) => account.id === plan.account);
    if (!account) throw new IssueKeeperError("ACCOUNT_UNAVAILABLE", "La cuenta de la propuesta ya no está disponible.");
    if (purpose === "apply" && account.readOnly) throw new IssueKeeperError("FORBIDDEN", "La cuenta es de sólo lectura.");
    if (account.siteUrl !== plan.site || purpose === "apply" && changePolicyFingerprint(config, account) !== plan.policyFingerprint) throw new IssueKeeperError("CONFLICT", "Cambió el sitio o la política de la propuesta; no se consultará otro destino.");
    if (account.auth.mode === "cloud-scoped-token") {
      const tenant = parse(z.looseObject({ cloudId: z.string() }), await this.http.tenant(account, context.signal));
      if (tenant.cloudId !== account.auth.cloudId) throw new IssueKeeperError("CONFIG_INVALID", "El cloudId no corresponde al sitio configurado.");
    }
    const credential = await this.http.identityForWrite(account, context.signal);
    if (credential.identity !== plan.credentialIdentity) throw new IssueKeeperError("CONFLICT", "Cambió la identidad de la credencial de la propuesta.");
    const payload = parse(PreparedPayload, plan.payload);
    if (payload.upload) return this.validateUpload(plan, context, purpose, progress, account, credential, payload);
    const request = validateMutation(payload.request);
    if (request.issueKey !== plan.issueKey || plan.steps.length !== 1 || request.kind === "jsm-publish") throw new IssueKeeperError("VALIDATION_FAILED", "Plan incompatible con la operación.");
    if (plan.kind === "fields" ? request.kind !== "fields" : plan.kind === "transition" ? request.kind !== "transition"
      : plan.kind === "comment" ? !["platform-comment", "jsm-comment"].includes(request.kind) : true) throw new IssueKeeperError("VALIDATION_FAILED", "El tipo de operación no corresponde al plan.");
    const requested = request.kind === "fields" ? [...Object.keys(request.fields ?? {}), ...Object.keys(request.update ?? {})] : request.kind === "transition" ? Object.keys(request.fields ?? {}) : [];
    await this.authorizeRead(plan.issueKey);
    const issue = parse(Issue, await this.http.jsonBound(account, `rest/api/3/issue/${plan.issueKey}?fields=${[...new Set(["updated", "project", "status", ...requested])].join(",")}`, credential, context.signal));
    checkProject(account, issue.fields.project.key);
    await this.authorizeRead(issue.key, issue.fields.project.key);
    if (purpose === "apply") {
      const permission = request.kind === "fields" ? "EDIT_ISSUES" : request.kind === "transition" ? "TRANSITION_ISSUES" : "ADD_COMMENTS";
      const permissions = parse(z.looseObject({ permissions: z.record(z.string(), z.looseObject({ havePermission: z.boolean() })) }), await this.http.jsonBound(account, `rest/api/3/mypermissions?issueKey=${issue.key}&permissions=${permission}`, credential, context.signal));
      if (!permissions.permissions[permission]?.havePermission) throw new IssueKeeperError("FORBIDDEN", "La credencial ya no tiene el permiso Jira necesario para este cambio.");
    }
    if (request.kind === "fields" || request.kind === "transition") {
      if (purpose === "apply") {
        const metadata = request.kind === "fields" ? await this.http.jsonBound(account, `rest/api/3/issue/${issue.key}/editmeta`, credential, context.signal) : undefined;
        let fields = metadata;
        if (request.kind === "transition") {
          const transitions = parse(z.looseObject({ transitions: z.array(z.looseObject({ id: z.string(), to: z.looseObject({ id: z.string() }), fields: z.record(z.string(), z.json()) })).max(1000) }), await this.http.jsonBound(account, `rest/api/3/issue/${issue.key}/transitions?expand=transitions.fields`, credential, context.signal));
          const transition = transitions.transitions.find((item) => item.id === request.transitionId);
          if (!transition || transition.to.id !== payload.expectedStatusId) throw new IssueKeeperError("CONFLICT", "La transición aprobada ya no está disponible o cambió de destino.");
          fields = { fields: transition.fields };
        }
        const normalized = normalizeMetadata(fields);
        let existing = issue.fields as Record<string, JsonValue>;
        if (request.kind === "transition" && normalized.some((field) => field.required && !Object.hasOwn(existing, field.id))) {
          const fresh = parse(Issue, await this.http.jsonBound(account, `rest/api/3/issue/${issue.key}?fields=${[...new Set(["updated", "project", "status", ...requested, ...normalized.filter((field) => field.required).map((field) => field.id)])].join(",")}`, credential, context.signal));
          if (fresh.id !== issue.id || fresh.key !== issue.key || fresh.fields.project.key !== issue.fields.project.key || Date.parse(fresh.fields.updated) !== Date.parse(issue.fields.updated)) throw new IssueKeeperError("CONFLICT", "Cambió el ticket al resolver requisitos.");
          existing = fresh.fields as Record<string, JsonValue>;
        }
        await validateFieldChanges({ ...(request.fields ? { fields: request.fields } : {}), ...(request.kind === "fields" && request.update ? { update: request.update } : {}) }, normalized, {
          restricted: account.restrictedUpdateFields, transition: request.kind === "transition", existing,
          validatePerson: async (person, field) => {
            if (field === "assignee") await this.audience.assignable(account, issue.key, person, credential, context.signal);
            else await this.audience.person(account, { issueKey: issue.key, projectKey: issue.fields.project.key }, person, "ticket", undefined, credential, context.signal);
          },
        });
        const expected = finalFields(request, issue.fields);
        const fixed = payload.expectedFields ?? {};
        if (canonicalJSON(Object.keys(expected).sort()) !== canonicalJSON(Object.keys(fixed).sort()) || !Object.keys(expected).every((field) => same(expected[field], fixed[field]))) throw new IssueKeeperError("CONFLICT", "Los valores finales no corresponden a los aprobados.");
      }
    } else if (request.kind === "platform-comment" || request.kind === "jsm-comment") {
      const converted = parse(SavedPublication, payload.publication);
      if (!same(request.body, request.kind === "jsm-comment" ? converted.wiki : converted.adf)) throw new IssueKeeperError("CONFLICT", "La representación no corresponde al documento fijado.");
      if (request.kind === "platform-comment" && plan.audience !== "ticket" || request.kind === "jsm-comment" && (plan.audience === "ticket" || request.public !== (plan.audience === "public"))) throw new IssueKeeperError("VALIDATION_FAILED", "La audiencia no corresponde al plan.");
      let ticket = { issueKey: issue.key, projectKey: issue.fields.project.key } as { issueKey: string; projectKey: string; reporterId?: string; serviceDeskId?: string };
      if (request.kind === "jsm-comment") {
        if (!account.serviceManagement.enabled) throw new IssueKeeperError("FORBIDDEN", "JSM no está habilitado para la cuenta.");
        const remote = parse(z.looseObject({ issueId: z.string(), serviceDeskId: z.string(), reporter: z.looseObject({ accountId: z.string() }) }), await this.http.jsonBound(account, `rest/servicedeskapi/request/${issue.key}`, credential, context.signal));
        if (remote.issueId !== issue.id) invalidResponse(); ticket = { ...ticket, serviceDeskId: remote.serviceDeskId, reporterId: remote.reporter.accountId };
      }
      if (request.kind === "platform-comment" && request.visibility?.type === "group") {
        const resolved = await this.audience.visibility(account, request.visibility, credential, context.signal);
        if (request.visibility.identifier && request.visibility.identifier !== resolved.identifier || purpose === "apply" && !request.visibility.identifier) throw new IssueKeeperError("CONFLICT", "Cambió el grupo o el plan no fija su identidad estable; no se enviará el comentario.");
      }
      if (purpose === "apply" && (plan.audience === "internal" || request.kind === "platform-comment" && request.visibility)) await this.audience.person(account, ticket, credential.identity, plan.audience!, request.kind === "platform-comment" ? request.visibility : undefined, credential, context.signal);
      for (const person of plan.mentions ?? []) await this.audience.mention(account, ticket, person.accountId, plan.audience!, request.kind === "platform-comment" ? request.visibility : undefined, credential, context.signal);
    }
    return { account: account.id, site: account.siteUrl, credentialIdentity: credential.identity, issueId: issue.id, issueKey: issue.key, projectKey: issue.fields.project.key, updated: issue.fields.updated,
      policyFingerprint: changePolicyFingerprint(config, account), binding: { account, credential, request, ...(payload.expectedFields ? { expectedFields: payload.expectedFields } : {}), ...(payload.expectedStatusId ? { expectedStatusId: payload.expectedStatusId } : {}) } };
  }

  private async validateUpload(plan: ChangePlan, context: ChangeContext, purpose: "apply" | "verify", progress: StoredChange | undefined, account: Account, credential: CredentialLease, payload: z.infer<typeof PreparedPayload>): Promise<ChangeValidation<JiraChangeBinding>> {
    const upload = payload.upload!; const jsm = plan.audience !== "ticket";
    const config = this.configuration();
    if (!["upload", "comment-with-attachments"].includes(plan.kind) || payload.request || !plan.files.length || jsm !== Boolean(upload.serviceDeskId) || !jsm && upload.additionalComment) throw new IssueKeeperError("VALIDATION_FAILED", "Manifiesto de carga inconsistente.");
    if (purpose === "apply" && (!config.attachments.enabled || plan.files.length > config.attachments.maxFilesPerUpload || plan.files.some((file) => file.size > config.attachments.maxFileBytes) || plan.files.reduce((sum, file) => sum + file.size, 0) > config.attachments.maxBatchBytes)) throw new IssueKeeperError("ATTACHMENT_TOO_LARGE", "La carga no está habilitada o excede los límites actuales.");
    const steps = plan.steps;
    if (steps.length !== plan.files.length + (jsm ? 1 : 0) || plan.files.some((file, index) => steps[index]?.kind !== (jsm ? "temporary-upload" : "mutation") || canonicalJSON(steps[index]?.fileRefs) !== canonicalJSON([file.stagedRef])) || jsm && (steps.at(-1)?.kind !== "publish-attachments" || !same(steps.at(-1)?.fileRefs, plan.files.map((file) => file.stagedRef)))) throw new IssueKeeperError("VALIDATION_FAILED", "Pasos de carga inconsistentes.");
    await this.authorizeRead(plan.issueKey);
    const issue = parse(Issue, await this.http.jsonBound(account, `rest/api/3/issue/${plan.issueKey}?fields=updated,project,status,attachment`, credential, context.signal));
    checkProject(account, issue.fields.project.key); await this.authorizeRead(issue.key, issue.fields.project.key);
    if (purpose === "apply") {
      const required = jsm ? ["CREATE_ATTACHMENTS", "ADD_COMMENTS"] : ["CREATE_ATTACHMENTS"];
      const permissions = parse(z.looseObject({ permissions: z.record(z.string(), z.looseObject({ havePermission: z.boolean() })) }), await this.http.jsonBound(account, `rest/api/3/mypermissions?issueKey=${issue.key}&permissions=${required.join(",")}`, credential, context.signal));
      if (required.some((permission) => !permissions.permissions[permission]?.havePermission)) throw new IssueKeeperError("FORBIDDEN", "No se acredita permiso de carga o publicación.");
      const settings = parse(z.looseObject({ enabled: z.boolean(), uploadLimit: z.number().int().nonnegative() }), await this.http.jsonBound(account, "rest/api/3/attachment/meta", credential, context.signal));
      if (!settings.enabled || plan.files.some((file) => file.size > settings.uploadLimit)) throw new IssueKeeperError("ATTACHMENT_TOO_LARGE", "El sitio no admite los archivos preparados.");
    }
    if (jsm) {
      if (!account.serviceManagement.enabled) throw new IssueKeeperError("FORBIDDEN", "JSM no está habilitado.");
      const remote = parse(z.looseObject({ issueId: z.string(), serviceDeskId: z.string(), reporter: z.looseObject({ accountId: z.string() }) }), await this.http.jsonBound(account, `rest/servicedeskapi/request/${issue.key}`, credential, context.signal));
      if (remote.issueId !== issue.id || remote.serviceDeskId !== upload.serviceDeskId) throw new IssueKeeperError("CONFLICT", "Cambió el destino JSM de la propuesta.");
      if (purpose === "apply" && plan.audience === "internal") await this.audience.person(account, { issueKey: issue.key, projectKey: issue.fields.project.key, serviceDeskId: remote.serviceDeskId }, credential.identity, "internal", undefined, credential, context.signal);
      if (plan.kind === "comment-with-attachments") {
        const converted = parse(SavedPublication, payload.publication);
        if (converted.wiki !== upload.additionalComment?.body) throw new IssueKeeperError("CONFLICT", "La representación del comentario cambió.");
        for (const person of plan.mentions ?? []) await this.audience.mention(account, { issueKey: issue.key, projectKey: issue.fields.project.key, serviceDeskId: remote.serviceDeskId, reporterId: remote.reporter.accountId }, person.accountId, plan.audience!, undefined, credential, context.signal);
      } else if (upload.additionalComment) throw new IssueKeeperError("VALIDATION_FAILED", "Comentario no aprobado.");
    }
    let updated = issue.fields.updated;
    if (purpose === "apply" && progress) {
      const previous = [...plan.steps].reverse().map((step) => progress.receipts[step.id]).find((receipt) => receipt?.verifiedAt && receipt.continuationUpdated);
      if (previous) {
        if (Date.parse(previous.continuationUpdated!) !== Date.parse(updated)) throw new IssueKeeperError("CONFLICT", "Cambio externo entre fases; se conserva el progreso sin reenviar.");
        updated = plan.expectedUpdated;
      }
    }
    return { account: account.id, site: account.siteUrl, credentialIdentity: credential.identity, issueId: issue.id, issueKey: issue.key, projectKey: issue.fields.project.key, policyFingerprint: changePolicyFingerprint(config, account), updated, binding: { account, credential, upload, baselineUpdated: issue.fields.updated } };
  }

  private async sendUpload(plan: ChangePlan, step: ChangePlan["steps"][number], binding: JiraChangeBinding, context: ChangeContext, beforeSend: () => Promise<void>, progress?: StoredChange): Promise<StepOutcome> {
    const upload = binding.upload!; let response;
    if (step.kind === "publish-attachments") {
      const ids = plan.steps.filter((step) => step.kind === "temporary-upload").flatMap((step) => {
        const receipt = progress?.receipts[step.id];
        const age = receipt ? Date.now() - Date.parse(receipt.confirmedAt) : -1;
        if (!receipt?.verifiedAt || receipt.temporaryAttachmentIds.length !== 1 || age < 0 || age > 10 * 60 * 1000) throw new IssueKeeperError("CONFLICT", "Temporal ausente o sin vigencia acreditada; no se repetirá la carga.");
        return receipt.temporaryAttachmentIds;
      });
      response = await this.http.mutate(binding.account, { kind: "jsm-publish", issueKey: plan.issueKey, temporaryAttachmentIds: ids, public: plan.audience === "public", ...(upload.additionalComment ? { additionalComment: upload.additionalComment } : {}) }, binding.credential, context.signal, beforeSend);
    } else {
      const file = plan.files.find((file) => file.stagedRef === step.fileRefs[0])!;
      response = await this.http.upload(binding.account, upload.serviceDeskId ? { kind: "jsm-temporary", serviceDeskId: upload.serviceDeskId } : { kind: "platform", issueKey: plan.issueKey }, statePaths(this.options.data ?? userDataDirectory()).staging, file, binding.credential, context.signal, beforeSend);
    }
    if (response.outcome === "rejected") return { outcome: "rejected", status: response.status };
    const confirmedAt = new Date().toISOString();
    if (step.kind === "temporary-upload") {
      const data = parse(z.looseObject({ temporaryAttachments: z.array(z.looseObject({ temporaryAttachmentId: z.string().regex(/^[A-Za-z0-9_-]+$/), fileName: z.string() })).length(1) }), response.data);
      if (data.temporaryAttachments[0]!.fileName !== plan.files.find((file) => file.stagedRef === step.fileRefs[0])!.publishedName) return { outcome: "unknown" };
      return { outcome: "confirmed", receipt: { remoteIds: [], temporaryAttachmentIds: [data.temporaryAttachments[0]!.temporaryAttachmentId], confirmedAt } };
    }
    if (step.kind === "publish-attachments") {
      const data = parse(z.looseObject({ comment: z.looseObject({ id: z.string().regex(/^\d+$/), body: z.string(), public: z.boolean(), author: z.looseObject({ accountId: z.string() }) }), attachments: z.looseObject({ values: z.array(z.looseObject({ filename: z.string(), size: z.number().int().nonnegative(), _links: z.looseObject({ jiraRest: z.string() }) })).max(20) }) }), response.data);
      const ids = data.attachments.values.map((item) => attachmentLinkId(binding.account, item._links.jiraRest));
      if (ids.length !== plan.files.length || new Set(ids).size !== plan.files.length) return { outcome: "unknown" };
      const matches = data.comment.public === (plan.audience === "public") && data.comment.author.accountId === plan.credentialIdentity && attachmentBodyMatches(data.comment.body, upload.additionalComment?.body ?? "", plan.files.map((file) => file.publishedName));
      return { outcome: "confirmed", receipt: { remoteIds: [data.comment.id, ...ids], temporaryAttachmentIds: [], confirmedAt, ...(matches ? { publicationBodyHash: createHash("sha256").update(data.comment.body).digest("hex") } : {}) } };
    }
    const data = parse(z.array(z.looseObject({ id: z.string().regex(/^\d+$/) })).length(1), response.data);
    return { outcome: "confirmed", receipt: { remoteIds: [data[0]!.id], temporaryAttachmentIds: [], confirmedAt, baselineUpdated: binding.baselineUpdated! } };
  }

  private async verifyUpload(plan: ChangePlan, step: ChangePlan["steps"][number], receipt: StepReceipt, binding: JiraChangeBinding, context: ChangeContext): Promise<boolean | { updated: string }> {
    if (step.kind === "temporary-upload") { const age = Date.now() - Date.parse(receipt.confirmedAt); return receipt.temporaryAttachmentIds.length === 1 && receipt.remoteIds.length === 0 && age >= 0 && age < 10 * 60 * 1000; }
    const ids = step.kind === "publish-attachments" ? receipt.remoteIds.slice(1) : receipt.remoteIds;
    if (ids.length !== step.fileRefs.length || new Set(ids).size !== ids.length || ids.some((id) => !/^\d+$/.test(id))) return false;
    const issue = parse(Issue, await this.http.jsonBound(binding.account, `rest/api/3/issue/${plan.issueKey}?fields=updated,project,status,attachment&expand=changelog`, binding.credential, context.signal));
    if (issue.id !== plan.issueId || issue.fields.project.key !== plan.projectKey || !Array.isArray(issue.fields.attachment)) return false;
    const remaining = step.fileRefs.map((ref) => plan.files.find((file) => file.stagedRef === ref)!);
    for (const id of ids) {
      if (!issue.fields.attachment.some((item: unknown) => item && typeof item === "object" && "id" in item && item.id === id)) return false;
      const metadata = parse(z.looseObject({ id: PlatformAttachment.shape.id, filename: z.string(), size: z.number().int().nonnegative(), author: z.looseObject({ accountId: z.string() }) }), await this.http.jsonBound(binding.account, `rest/api/3/attachment/${id}`, binding.credential, context.signal));
      const candidates = remaining.filter((file) => metadata.filename === file.publishedName && metadata.size === file.size);
      if (metadata.id !== id || !candidates.length || metadata.author.accountId !== plan.credentialIdentity) return false;
      const file = candidates[0]!;
      if (!this.options.authorizeDownload) throw new IssueKeeperError("FORBIDDEN", "Verificar bytes remotos requiere permiso de descarga separado.");
      await this.options.authorizeDownload(plan, id);
      const current = await context.resolve(); context.signal.throwIfAborted();
      if (current.sessionID !== plan.sessionID || current.locationID !== plan.locationID) throw new IssueKeeperError("FILE_ACCESS_DENIED", "Cambió el contexto durante el permiso de descarga; no se transferirán bytes.");
      const hash = await this.http.read(binding.account, `rest/api/3/attachment/content/${id}`, context.signal, async (response, signal) => {
        const reader = response.body?.getReader(); if (!reader) invalidResponse();
        const hash = createHash("sha256"); let size = 0;
        const abort = () => { void reader.cancel().catch(() => {}); };
        signal.addEventListener("abort", abort, { once: true });
        try { for (;;) { signal.throwIfAborted(); const { done, value } = await reader.read(); signal.throwIfAborted(); if (done) break; size += value.byteLength; if (size > file.size) return ""; hash.update(value); } return size === file.size ? hash.digest("hex") : ""; }
        finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }, undefined, true, await boundAuthorization(binding.credential, binding.account));
      const matched = remaining.findIndex((file) => candidates.includes(file) && file.sha256 === hash);
      if (matched < 0) return false;
      remaining.splice(matched, 1);
    }
    if (step.kind === "publish-attachments") {
      const id = receipt.remoteIds[0]; if (!id || !/^\d+$/.test(id)) return false;
      const comment = parse(z.looseObject({ id: z.string(), body: z.string(), public: z.boolean(), author: z.looseObject({ accountId: z.string() }) }), await this.http.jsonBound(binding.account, `rest/servicedeskapi/request/${plan.issueKey}/comment/${id}`, binding.credential, context.signal));
      if (comment.id !== id || comment.author.accountId !== plan.credentialIdentity || comment.public !== (plan.audience === "public") || !receipt.publicationBodyHash || createHash("sha256").update(comment.body).digest("hex") !== receipt.publicationBodyHash || !attachmentBodyMatches(comment.body, binding.upload?.additionalComment?.body ?? "", plan.files.map((file) => file.publishedName)) || !await this.verifyJsmMentions(plan, id, binding, context)) return false;
    }
    const morePlatformFiles = plan.audience === "ticket" && plan.steps.findIndex((item) => item.id === step.id) !== plan.steps.length - 1;
    if (morePlatformFiles) {
      const history = parse(z.looseObject({ startAt: z.number().int().nonnegative().default(0), total: z.number().int().nonnegative(), histories: z.array(z.looseObject({ created: Timestamp, author: z.looseObject({ accountId: z.string() }), items: z.array(z.looseObject({ field: z.string(), to: z.union([z.string(), z.number()]).nullable().optional() })).min(1) })).max(1000) }), issue.changelog);
      const baseline = Date.parse(receipt.baselineUpdated ?? plan.expectedUpdated);
      const recent = history.histories.filter((entry) => Date.parse(entry.created) > baseline);
      if (history.startAt + history.histories.length !== history.total || history.startAt > 0 && !history.histories.some((entry) => Date.parse(entry.created) <= baseline)
        || !recent.length || !recent.some((entry) => Date.parse(entry.created) === Date.parse(issue.fields.updated))
        || recent.some((entry) => entry.author.accountId !== plan.credentialIdentity || entry.items.some((item) => item.field.toLowerCase() !== "attachment" || !ids.includes(String(item.to))))) return false;
    }
    const after = parse(Issue, await this.http.jsonBound(binding.account, `rest/api/3/issue/${plan.issueKey}?fields=updated,project,status`, binding.credential, context.signal));
    return after.id === plan.issueId && after.fields.updated === issue.fields.updated ? { updated: after.fields.updated } : false;
  }

  async send(plan: ChangePlan, step: ChangePlan["steps"][number], binding: JiraChangeBinding, context: ChangeContext, beforeSend: () => Promise<void>, progress?: StoredChange): Promise<StepOutcome> {
    try {
      if (binding.upload) return await this.sendUpload(plan, step, binding, context, beforeSend, progress);
      const request = binding.request!;
      const response = await this.http.mutate(binding.account, request, binding.credential, context.signal, beforeSend);
      if (response.outcome === "rejected") return { outcome: "rejected", status: response.status };
      const comment = ["platform-comment", "jsm-comment"].includes(request.kind);
      const remoteIds = comment ? [parse(z.looseObject({ id: z.string().min(1) }), response.data).id] : [];
      return { outcome: "confirmed", receipt: { remoteIds, temporaryAttachmentIds: [], confirmedAt: new Date().toISOString() } };
    } catch (error) {
      if (error instanceof MutationUncertainError) { if (context.signal.aborted) throw context.signal.reason; return { outcome: "unknown" }; }
      throw error;
    }
  }

  async verify(plan: ChangePlan, step: ChangePlan["steps"][number], receipt: StepReceipt, binding: JiraChangeBinding, context: ChangeContext): Promise<boolean | { updated: string }> {
    if (binding.upload) return this.verifyUpload(plan, step, receipt, binding, context);
    const request = binding.request!;
    if (["fields", "transition"].includes(request.kind)) {
      const fields = Object.keys(binding.expectedFields ?? {});
      const issue = parse(Issue, await this.http.jsonBound(binding.account, `rest/api/3/issue/${plan.issueKey}?fields=${[...new Set(["project", "updated", "status", ...fields])].join(",")}`, binding.credential, context.signal));
      const payload = parse(PreparedPayload, plan.payload);
      return issue.id === plan.issueId && issue.fields.project.key === plan.projectKey && fields.every((field) => sameField(field, issue.fields[field], binding.expectedFields![field], payload.previousFields?.[field]))
        && (request.kind !== "transition" || issue.fields.status.id === binding.expectedStatusId);
    }
    const id = receipt.remoteIds[0]; if (!id || !/^\d+$/.test(id)) return false;
    const jsm = request.kind === "jsm-comment";
    const comment = parse(z.looseObject({ id: z.string(), body: z.json(), author: z.looseObject({ accountId: z.string() }), public: z.boolean().optional(), visibility: z.json().optional() }), await this.http.jsonBound(binding.account, `rest/${jsm ? "servicedeskapi/request" : "api/3/issue"}/${plan.issueKey}/comment/${id}`, binding.credential, context.signal));
    return comment.id === id && comment.author.accountId === plan.credentialIdentity && "body" in request && (jsm ? same(comment.body, request.body) : sameADF(comment.body, request.body))
      && (request.kind === "jsm-comment" ? comment.public === request.public && await this.verifyJsmMentions(plan, id, binding, context) : request.kind === "platform-comment" && sameVisibility(comment.visibility, request.visibility));
  }

  private async verifyJsmMentions(plan: ChangePlan, id: string, binding: JiraChangeBinding, context: ChangeContext): Promise<boolean> {
    if (!plan.mentions?.length) return true;
    const comment = parse(z.looseObject({ id: z.string(), body: z.json(), author: z.looseObject({ accountId: z.string() }) }), await this.http.jsonBound(binding.account, `rest/api/3/issue/${plan.issueKey}/comment/${id}`, binding.credential, context.signal));
    const actual = adfText(comment.body);
    return comment.id === id && comment.author.accountId === plan.credentialIdentity && !actual.warnings.some((warning) => /incompleto|identidad/.test(warning)) && same(actual.mentions.map((mention) => mention.accountId).sort(), plan.mentions.map((mention) => mention.accountId).sort());
  }
}
