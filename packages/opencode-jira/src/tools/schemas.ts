import { z } from "zod";
import { Alias, ReadField } from "../config.js";

export const IssueKey = z.string().min(3).max(100).regex(/^[A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*$/).transform((v) => v.toUpperCase());
export const AccountsInput = z.strictObject({});
export const ConnectionInput = z.strictObject({ account: Alias });
const fields = z.array(ReadField).min(1).max(30).optional();
const pagination = { maxResults: z.number().int().min(1).max(100).optional(), cursor: z.string().uuid().optional() };
const ref = { account: Alias, issueKey: IssueKey };
export const GetInput = z.strictObject({ ...ref, fields });
export const SearchInput = z.strictObject({
  account: Alias,
  jql: z.string().trim().min(1).max(10000).refine((v) => !/[\x00-\x1f\x7f]/.test(v)),
  ...pagination,
  fields,
});
export const CommentsInput = z.strictObject({ ...ref, ...pagination, audience: z.enum(["ticket", "internal", "public"]).optional() });
export const AttachmentsInput = z.strictObject({ ...ref, ...pagination });
export const MentionsInput = z.strictObject({
  ...ref, ...pagination, audience: z.enum(["ticket", "internal", "public"]),
  query: z.string().trim().min(2).max(100).refine((v) => !/[\x00-\x1f\x7f]/.test(v)).optional(),
  accountId: z.string().min(1).max(200).refine((v) => !/[\x00-\x1f\x7f]/.test(v)).optional(),
  visibility: z.strictObject({ type: z.enum(["role", "group"]), value: z.string().min(1).max(200) }).optional(),
}).refine((v) => Boolean(v.query) !== Boolean(v.accountId), { path: ["query"] })
  .refine((v) => !v.visibility || v.audience === "ticket", { path: ["visibility"] });
export const DownloadInput = z.strictObject({
  ...ref,
  attachmentId: z.string().regex(/^[1-9][0-9]{0,29}$/),
  destinationName: z.string().min(1).max(160).regex(/^[\p{L}\p{N}_][\p{L}\p{N}._ -]*$/u).refine((v) => !v.endsWith(".") && !v.endsWith(" ")).optional(),
});
export type Get = z.infer<typeof GetInput>;
export type Search = z.infer<typeof SearchInput>;
export type Comments = z.infer<typeof CommentsInput>;
export type Attachments = z.infer<typeof AttachmentsInput>;
export type Download = z.infer<typeof DownloadInput>;
export type Mentions = z.infer<typeof MentionsInput>;
