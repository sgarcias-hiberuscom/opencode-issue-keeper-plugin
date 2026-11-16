import { z } from "zod";
import { invalidResponse } from "../errors.js";

export const Id = z.string().min(1).max(200);
export const UserSchema = z.object({ accountId: Id, displayName: z.string().optional(), active: z.boolean().optional() });
export const ProjectSchema = z.object({ id: Id, key: z.string().regex(/^[A-Z][A-Z0-9_]*$/), projectTypeKey: z.string().optional() });
export const IssueSchema = z.object({
  id: Id, key: z.string().regex(/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/),
  fields: z.object({
    project: ProjectSchema, updated: z.string().min(1), summary: z.string(),
    status: z.object({ id: Id, name: z.string() }),
    description: z.unknown().optional(), assignee: UserSchema.nullable().optional(), reporter: UserSchema.optional(),
    labels: z.array(z.string()).optional(),
  }).catchall(z.unknown()),
});
export const RequestSchema = z.object({
  issueId: Id, issueKey: z.string().regex(/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/),
  serviceDeskId: Id, requestTypeId: Id, summary: z.string(),
  reporter: UserSchema.optional(),
  currentStatus: z.object({ status: z.string() }),
  serviceDesk: z.object({ id: Id, projectId: Id, projectKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }).optional(),
  requestFieldValues: z.array(z.object({ fieldId: z.string(), value: z.unknown() })).optional(),
});
export const PlatformAttachment = z.object({
  id: z.string().regex(/^[1-9][0-9]*$/), filename: z.string().min(1), size: z.number().int().nonnegative(), mimeType: z.string(),
  author: UserSchema.optional(), created: z.string().optional(),
});
export const JsmAttachment = PlatformAttachment.omit({ id: true }).extend({
  _links: z.object({ jiraRest: z.string() }),
  created: z.union([z.string(), z.object({ iso8601: z.string() }).transform((v) => v.iso8601)]).optional(),
});
export const PlatformComment = z.object({
  id: Id, body: z.unknown(), author: UserSchema.optional(), created: z.string().optional(),
  visibility: z.object({ type: z.string(), value: z.string() }).optional(),
  jsdPublic: z.boolean().optional(),
});
export const JsmComment = z.object({
  id: Id, body: z.string(), public: z.boolean(), author: UserSchema.optional(),
  created: z.object({ iso8601: z.string() }).optional(),
});
export const jsmPage = <T extends z.ZodType>(item: T) => z.object({
  start: z.number().int().nonnegative(), limit: z.number().int().positive(), size: z.number().int().nonnegative(),
  isLastPage: z.boolean(), values: z.array(item),
});
export function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) invalidResponse();
  return result.data;
}
