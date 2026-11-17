import { z } from "zod";
import { Alias, ReadField } from "../config.js";

export const IssueKey = z.string().min(3).max(100).regex(/^[A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*$/).transform((v) => v.toUpperCase());
export const AccountsInput = z.strictObject({});
export const ConnectionInput = z.strictObject({ account: Alias });
const fields = z.array(ReadField).min(1).max(30).describe("Solo campos pedidos. Para resumen y estado: [\"summary\", \"status\"]. Omitir fields usa la selección habitual, no una selección mínima. No usar *all ni comment, attachment o worklog.").optional();
export const pageSize = (maximum: number) => z.number().int().min(1).max(maximum).describe(`Tamaño de esta página, máximo ${maximum}; no es el total de resultados. Omitir si el usuario no pide un tamaño concreto.`).optional();
const pagination = {
  maxResults: pageSize(100),
  cursor: z.string().uuid().describe("Cursor devuelto por esta herramienta con la misma cuenta, consulta, ticket, campos y audiencia. No inventarlo.").optional(),
};
const ref = {
  account: Alias.describe("Alias de la cuenta Jira seleccionada; usar directamente el indicado por el usuario."),
  issueKey: IssueKey,
};
export const GetInput = z.strictObject({ ...ref, fields });
export const SearchInput = z.strictObject({
  account: Alias,
  jql: z.string().trim().min(1).max(10000).refine((v) => !/[\x00-\x1f\x7f]/.test(v)).describe("JQL acotada. Mis tickets: assignee = currentUser() de esta cuenta. Abiertos: statusCategory != Done. Conservar proyecto y demás filtros pedidos."),
  ...pagination,
  fields,
});
export const CommentsInput = z.strictObject({ ...ref, ...pagination, audience: z.enum(["ticket", "internal", "public"]).optional() });
export const AttachmentsInput = z.strictObject({ ...ref, ...pagination });
export const MentionsInput = z.strictObject({
  ...ref, ...pagination,
  audience: z.enum(["ticket", "internal", "public"]).describe("Obligatorio: public para mención pública JSM, internal para nota interna JSM, ticket para comentario ordinario. Si la intención no fija audiencia, preguntar."),
  query: z.string().trim().min(2).max(100).refine((v) => !/[\x00-\x1f\x7f]/.test(v)).optional(),
  accountId: z.string().min(1).max(200).refine((v) => !/[\x00-\x1f\x7f]/.test(v)).optional(),
  visibility: z.strictObject({ type: z.enum(["role", "group"]), value: z.string().min(1).max(200) }).optional(),
}).refine((v) => Boolean(v.query) !== Boolean(v.accountId), { path: ["query"] })
  .refine((v) => !v.visibility || v.audience === "ticket", { path: ["visibility"] });
export const DownloadInput = z.strictObject({
  ...ref,
  attachmentId: z.string().regex(/^[1-9][0-9]{0,29}$/).describe("ID obtenido al listar adjuntos de este ticket y esta cuenta; no un ID global de otro ticket."),
  destinationName: z.string().min(1).max(160).regex(/^[\p{L}\p{N}_][\p{L}\p{N}._ -]*$/u).refine((v) => !v.endsWith(".") && !v.endsWith(" ")).optional(),
});
export type Get = z.infer<typeof GetInput>;
export type Search = z.infer<typeof SearchInput>;
export type Comments = z.infer<typeof CommentsInput>;
export type Attachments = z.infer<typeof AttachmentsInput>;
export type Download = z.infer<typeof DownloadInput>;
export type Mentions = z.infer<typeof MentionsInput>;
