import { createHash } from "node:crypto";
import { z } from "zod";

export class PlanValidationError extends Error {
  constructor() { super("El plan de cambio no es un documento JSON válido y acotado."); }
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const planLimits = Object.freeze({ bytes: 1024 * 1024, nodes: 10000, depth: 32, steps: 64, files: 20 });

export function canonicalJSON(value: unknown): string {
  let nodes = 0;
  let bytes = 0;
  const active = new Set<object>();
  function add(text: string): string {
    bytes += Buffer.byteLength(text);
    if (bytes > planLimits.bytes) throw new PlanValidationError();
    return text;
  }
  function encode(item: unknown, depth: number): string {
    if (++nodes > planLimits.nodes || depth > planLimits.depth) throw new PlanValidationError();
    if (typeof item === "string" && item.length > planLimits.bytes) throw new PlanValidationError();
    if (item === null || typeof item === "boolean" || typeof item === "string" || typeof item === "number" && Number.isFinite(item)) return add(JSON.stringify(item));
    if (typeof item !== "object" || !item || active.has(item)) throw new PlanValidationError();
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new PlanValidationError();
    const keys = Reflect.ownKeys(item);
    if (keys.some((key) => typeof key !== "string")) throw new PlanValidationError();
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.entries(descriptors).some(([key, descriptor]) => (!array || key !== "length") && (!descriptor.enumerable || !("value" in descriptor)))) throw new PlanValidationError();
    active.add(item);
    let result: string;
    if (array) {
      if (keys.length !== item.length + 1) throw new PlanValidationError();
      const entries: string[] = [];
      add("[]" + ",".repeat(Math.max(0, item.length - 1)));
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) throw new PlanValidationError();
        entries.push(encode(descriptor.value, depth + 1));
      }
      result = `[${entries.join(",")}]`;
    } else {
      add("{}" + ",".repeat(Math.max(0, keys.length - 1)));
      result = `{${(keys as string[]).sort().map((key) => `${add(JSON.stringify(key) + ":")}${encode(descriptors[key]!.value, depth + 1)}`).join(",")}}`;
    }
    active.delete(item);
    return result;
  }
  return encode(value, 0);
}

export const LocalId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export const RemoteId = z.string().min(1).max(256).refine((value) => !/[\x00-\x1f\x7f]/.test(value));
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const Timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/)
  .refine((value) => {
    const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
    return Number.isFinite(Date.parse(value)) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10) && Number(value.slice(11, 13)) < 24;
  });
export const PinnedFileSchema = z.strictObject({
  stagedRef: LocalId, publishedName: z.string().min(1).max(255).refine((value) => !/[\/\\\x00-\x1f\x7f]/.test(value) && ![".", ".."].includes(value)),
  size: z.number().int().min(0).max(100 * 1024 * 1024), sha256: Sha256,
});
const StepSchema = z.strictObject({
  id: LocalId, kind: z.enum(["mutation", "temporary-upload", "publish-attachments"]), fileRefs: z.array(LocalId).max(planLimits.files),
});
export const ChangePlanSchema = z.strictObject({
  version: z.literal(1), id: LocalId, sessionID: LocalId, locationID: Sha256,
  account: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), site: z.string().refine((value) => {
    try { const url = new URL(value); return url.protocol === "https:" && url.origin === value; } catch { return false; }
  }),
  credentialIdentity: RemoteId, issueId: RemoteId, issueKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/), projectKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  kind: z.enum(["fields", "comment", "transition", "upload", "comment-with-attachments"]),
  audience: z.enum(["ticket", "internal", "public"]).optional(), commentText: z.string().min(1).optional(), commentFormat: z.enum(["plain", "markdown"]).optional(),
  mentions: z.array(z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().positive(), accountId: RemoteId, displayName: z.string().min(1).max(256) })).max(100).optional(),
  files: z.array(PinnedFileSchema).max(planLimits.files), steps: z.array(StepSchema).min(1).max(planLimits.steps),
  expectedUpdated: Timestamp, policyFingerprint: Sha256, payload: z.json(), summary: z.string().min(1).max(4000), createdAt: Timestamp, expiresAt: Timestamp,
}).superRefine((plan, ctx) => {
  const reject = () => ctx.addIssue({ code: "custom", message: "Inconsistent plan" });
  if (Date.parse(plan.createdAt) >= Date.parse(plan.expiresAt)) reject();
  if (new Set(plan.steps.map((step) => step.id)).size !== plan.steps.length || new Set(plan.files.map((file) => file.stagedRef)).size !== plan.files.length) reject();
  if (plan.steps.some((step) => new Set(step.fileRefs).size !== step.fileRefs.length || step.fileRefs.some((ref) => !plan.files.some((file) => file.stagedRef === ref)))) reject();
  if (plan.files.some((file) => !plan.steps.some((step) => step.fileRefs.includes(file.stagedRef)))) reject();
  const comment = ["comment", "comment-with-attachments"].includes(plan.kind);
  const upload = ["upload", "comment-with-attachments"].includes(plan.kind);
  if ((upload || comment) && !plan.audience || upload !== Boolean(plan.files.length)) reject();
  if (comment ? !plan.commentText || !plan.commentFormat : plan.commentText !== undefined || plan.commentFormat !== undefined || plan.mentions !== undefined) reject();
  if (plan.mentions?.some((mention) => mention.start >= mention.end || mention.end > plan.commentText!.length)) reject();
});
export type ChangePlan = z.infer<typeof ChangePlanSchema>;
export type PinnedFile = z.infer<typeof PinnedFileSchema>;

export function validatePlan(value: unknown): ChangePlan {
  try { return ChangePlanSchema.parse(JSON.parse(canonicalJSON(value))); }
  catch { throw new PlanValidationError(); }
}
export function planHash(plan: ChangePlan): string {
  return createHash("sha256").update(canonicalJSON(plan)).digest("hex");
}

export const ExecutionSchema = z.strictObject({
  proposalId: LocalId, payloadHash: Sha256, state: z.enum(["prepared", "applying", "applied", "failed", "unknown"]),
  revision: z.number().int().nonnegative(), updatedAt: Timestamp,
  steps: z.array(z.strictObject({ id: LocalId, state: z.enum(["pending", "sending", "confirmed", "failed", "unknown"]), rejectionStatus: z.number().int().min(400).max(499).optional() })).min(1).max(planLimits.steps),
});
export type ChangeExecution = z.infer<typeof ExecutionSchema>;
export const StepReceiptSchema = z.strictObject({
  remoteIds: z.array(RemoteId).max(21), temporaryAttachmentIds: z.array(RemoteId).max(20),
  confirmedAt: Timestamp, verifiedAt: Timestamp.optional(), baselineUpdated: Timestamp.optional(), continuationUpdated: Timestamp.optional(), publicationBodyHash: Sha256.optional(),
});
export type StepReceipt = z.infer<typeof StepReceiptSchema>;
export interface StoredChange { plan: ChangePlan; payloadHash: string; execution: ChangeExecution; receipts: Record<string, StepReceipt> }
