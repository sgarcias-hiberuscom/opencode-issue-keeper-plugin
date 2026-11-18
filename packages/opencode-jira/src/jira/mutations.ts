import { z } from "zod";
import { canonicalJSON } from "../core/proposals.js";
import { IssueKeeperError } from "../errors.js";

const key = z.string().regex(/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const fields = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/), z.json()).refine((value) =>
  !Object.keys(value).some((field) => ["comment", "comments", "attachment", "attachments", "transition", "transitions", "status", "worklog", "project"].includes(field.toLowerCase())));
const adf = z.object({ type: z.literal("doc"), version: z.literal(1), content: z.array(z.json()).min(1) }).strict();
const visibility = z.strictObject({ type: z.enum(["role", "group"]), value: z.string().min(1).max(256), identifier: z.string().min(1).max(256).optional() });
const MutationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fields"), issueKey: key, fields: fields.optional(), update: fields.optional() }).refine((request) => {
    const set = Object.keys(request.fields ?? {}); const update = Object.keys(request.update ?? {});
    return set.length + update.length > 0 && !set.some((field) => update.includes(field));
  }),
  z.strictObject({ kind: z.literal("transition"), issueKey: key, transitionId: id, fields: fields.optional() }),
  z.strictObject({ kind: z.literal("platform-comment"), issueKey: key, body: adf, visibility: visibility.optional() }),
  z.strictObject({ kind: z.literal("jsm-comment"), issueKey: key, body: z.string().min(1), public: z.boolean() }),
  z.strictObject({ kind: z.literal("jsm-publish"), issueKey: key, temporaryAttachmentIds: z.array(id).min(1).max(20), public: z.boolean(), additionalComment: z.strictObject({ body: z.string().min(1) }).optional() }),
]);
export type JiraMutation = z.infer<typeof MutationSchema>;

export function validateMutation(input: unknown): JiraMutation {
  try { return MutationSchema.parse(JSON.parse(canonicalJSON(input))); }
  catch { throw new IssueKeeperError("VALIDATION_FAILED", "Mutación Jira no válida; sólo se admiten operaciones tipadas preparadas."); }
}

export function mutationRequest(input: JiraMutation): { method: "POST" | "PUT"; path: string; body: string; status: number } {
  const request = validateMutation(input);
  const { kind, issueKey, ...parameters } = request;
  if (kind === "fields") return { method: "PUT", path: `rest/api/3/issue/${issueKey}`, body: canonicalJSON(parameters), status: 204 };
  if (kind === "transition") {
    const { transitionId, ...rest } = parameters as { transitionId: string; fields?: unknown };
    return { method: "POST", path: `rest/api/3/issue/${issueKey}/transitions`, body: canonicalJSON({ ...rest, transition: { id: transitionId } }), status: 204 };
  }
  if (kind === "platform-comment") {
    const { visibility: restriction, ...rest } = parameters as { body: unknown; visibility?: z.infer<typeof visibility> };
    return { method: "POST", path: `rest/api/3/issue/${issueKey}/comment`, body: canonicalJSON({ ...rest, ...(restriction ? { visibility: restriction.identifier ? { type: restriction.type, identifier: restriction.identifier } : { type: restriction.type, value: restriction.value } } : {}) }), status: 201 };
  }
  return { method: "POST", path: `rest/servicedeskapi/request/${issueKey}/${kind === "jsm-publish" ? "attachment" : "comment"}`, body: canonicalJSON(parameters), status: 201 };
}

export class MutationUncertainError extends Error {
  constructor(readonly reason: "transport" | "timeout" | "cancelled" | "response", readonly cancellation?: unknown) {
    super("No se puede confirmar el resultado del envío; no se repetirá automáticamente."); this.name = "MutationUncertainError";
  }
}
export type MutationResponse = { outcome: "confirmed"; status: number; data: unknown } | { outcome: "rejected"; status: number };
