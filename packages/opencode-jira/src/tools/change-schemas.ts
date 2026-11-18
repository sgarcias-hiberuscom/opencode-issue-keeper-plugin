import { z } from "zod";
import { Alias, Field } from "../config.js";
import { canonicalJSON, LocalId, PinnedFileSchema, RemoteId, Timestamp, type JsonValue } from "../core/proposals.js";
import { IssueKeeperError, validationFailure } from "../errors.js";
import { IssueKey } from "./schemas.js";

const ref = { account: Alias, issueKey: IssueKey };
const base = { ...ref, expectedUpdated: Timestamp };
const forbidden = new Set(["comment", "comments", "attachment", "attachments", "status", "transition", "transitions", "worklog", "project"]);
const editable = Field.refine((field) => !forbidden.has(field.toLowerCase()));
const json = z.unknown().superRefine((value, ctx) => { try { canonicalJSON(value); } catch { ctx.addIssue({ code: "custom", message: "JSON no válido o excesivo" }); } }).transform((value) => value as JsonValue);
const values = z.record(editable, json);
const operations = z.record(editable, z.array(z.union([z.strictObject({ set: json }), z.strictObject({ add: json }), z.strictObject({ remove: json })])).min(1).max(100));
const text = z.string().min(1).max(100000);
const mentions = z.array(z.strictObject({ accountId: RemoteId, start: z.number().int().nonnegative(), end: z.number().int().positive() })).max(100).optional();
const audience = z.enum(["ticket", "internal", "public"]);
const format = z.enum(["plain", "markdown"]);
const visibility = z.strictObject({ type: z.enum(["role", "group"]), value: RemoteId }).optional();

function ranges(source: string | undefined, mentions: Array<{ start: number; end: number }> | undefined, ctx: z.RefinementCtx) {
  if (!mentions) return;
  let end = 0;
  const split = (position: number) => position > 0 && position < source!.length && /[\uD800-\uDBFF]/.test(source![position - 1]!) && /[\uDC00-\uDFFF]/.test(source![position]!);
  for (const mention of [...mentions].sort((a, b) => a.start - b.start)) {
    if (!source || mention.start >= mention.end || mention.end > source.length || mention.start < end || split(mention.start) || split(mention.end)) ctx.addIssue({ code: "custom", path: ["mentions"], message: "Rangos de mención no válidos" });
    end = mention.end;
  }
}
export const EditMetadataInput = z.strictObject(ref);
export const TransitionsInput = z.strictObject(ref);
export const UpdatePrepareInput = z.strictObject({ ...base, fields: values.optional(), update: operations.optional() }).superRefine((input, ctx) => {
  const fields = Object.keys(input.fields ?? {}); const updates = Object.keys(input.update ?? {});
  if (!fields.length && !updates.length || fields.some((field) => updates.includes(field))) ctx.addIssue({ code: "custom", message: "Edición vacía o con campos duplicados" });
});
export const CommentPrepareInput = z.strictObject({ ...base, text, audience, visibility, format: format.default("plain"), mentions }).superRefine((input, ctx) => {
  if (input.visibility && input.audience !== "ticket") ctx.addIssue({ code: "custom", path: ["visibility"], message: "Sólo para comentarios Platform" });
  ranges(input.text, input.mentions, ctx);
});
export const UploadPrepareInput = z.strictObject({ ...base, audience,
  files: z.array(z.strictObject({ path: z.string().min(1).max(4096).refine((value) => !value.includes("\0") && !/^(?:https?|file|data):/i.test(value)), publishedName: PinnedFileSchema.shape.publishedName.refine((value) => !value.includes('"')).optional() })).min(1).max(20),
  comment: text.optional(), format: format.optional(), mentions,
}).superRefine((input, ctx) => {
  if (!input.comment && (input.format !== undefined || input.mentions !== undefined) || input.audience === "ticket" && input.comment !== undefined) ctx.addIssue({ code: "custom", message: "Formato/menciones requieren comentario JSM explícito" });
  ranges(input.comment, input.mentions, ctx);
});
export const TransitionPrepareInput = z.strictObject({ ...base, transitionId: RemoteId, fields: values.optional() });
export const ApplyInput = z.strictObject({ proposalId: LocalId });

export function parseChangeArguments<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  try { canonicalJSON(raw); return schema.parse(raw); }
  catch (error) {
    if (error instanceof z.ZodError) throw validationFailure(error.issues);
    throw new IssueKeeperError("VALIDATION_FAILED", "Argumentos de cambio no válidos; revise el contrato sin reenviar contenido adicional.");
  }
}
