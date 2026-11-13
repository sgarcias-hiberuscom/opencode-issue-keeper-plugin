import { z } from "zod";
import { Alias, Field, ProjectKey } from "../config.js";

export const IssueKey = z.string().min(3).max(100).regex(/^[A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*$/).transform((v) => v.toUpperCase());
export const AccountsInput = z.strictObject({});
export const ConnectionInput = z.strictObject({ account: Alias });
const fields = z.array(Field).min(1).max(30).optional();
const pagination = { maxResults: z.number().int().min(1).max(100).optional(), cursor: z.string().uuid().optional() };
const ref = { account: Alias, issueKey: IssueKey };
export const GetInput = z.strictObject({ ...ref, fields });
export const SearchInput = z.strictObject({
  account: Alias,
  project: ProjectKey,
  assignee: z.enum(["me", "unassigned"]).optional(),
  statusCategory: z.enum(["notDone", "To Do", "In Progress", "Done"]).optional(),
  updatedSince: z.iso.date().optional(),
  ...pagination,
  fields,
});
export const CommentsInput = z.strictObject({ ...ref, ...pagination, audience: z.enum(["ticket", "internal", "public"]).optional() });
export const AttachmentsInput = z.strictObject({ ...ref, ...pagination });
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
