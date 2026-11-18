import { z } from "zod";
import { canonicalJSON, type JsonValue } from "./proposals.js";
import { invalidResponse, IssueKeeperError } from "../errors.js";
import { validAdfDocument } from "./adf-document.js";

const fieldId = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/);
const record = z.record(fieldId, z.json());
const MetadataSchema = z.looseObject({ fields: z.record(fieldId, z.looseObject({
  name: z.string().min(1).max(256), required: z.boolean(),
  schema: z.looseObject({ type: z.string().min(1).max(100), items: z.string().max(100).optional(), custom: z.string().optional() }),
  operations: z.array(z.string().max(32)).max(20), allowedValues: z.array(z.json()).max(1000).optional(),
})) });
export interface EditableField {
  id: string; name: string; required: boolean; type: string; items?: string; operations: string[]; allowedIds?: string[]; allowedStrings?: string[];
}
const forbidden = new Set(["comment", "comments", "attachment", "attachments", "status", "transition", "transitions", "worklog", "project"]);
function reject(): never { throw new IssueKeeperError("VALIDATION_FAILED", "Campos, valores u operaciones incompatibles con la metadata y política del ticket."); }

export function normalizeMetadata(raw: unknown): EditableField[] {
  try { canonicalJSON(raw); } catch { invalidResponse(); }
  const parsed = MetadataSchema.safeParse(raw);
  if (!parsed.success || Object.keys(parsed.data.fields).length > 500) invalidResponse();
  return Object.entries(parsed.data.fields).map(([id, field]) => ({
    id, name: field.name, required: field.required, type: ["description", "environment"].includes(id) || field.schema.custom?.endsWith(":textarea") ? "adf" : field.schema.type, ...(field.schema.items ? { items: field.schema.items } : {}), operations: field.operations,
    ...(field.allowedValues ? { allowedIds: field.allowedValues.map((value) => value && typeof value === "object" && !Array.isArray(value) && typeof value.id === "string" ? value.id : "").filter(Boolean) } : {}),
    ...(field.allowedValues?.every((value) => typeof value === "string") ? { allowedStrings: field.allowedValues as string[] } : {}),
  }));
}

export function offeredFields(fields: readonly EditableField[], restricted: readonly string[], transition = false): EditableField[] {
  return fields.filter((field) => transition && field.required || !forbidden.has(field.id.toLowerCase()) && !restricted.includes(field.id)).map((field) => structuredClone(field));
}

export interface FieldValidationOptions {
  restricted: readonly string[];
  transition?: boolean;
  existing?: Record<string, JsonValue>;
  validatePerson: (accountId: string, field: string) => Promise<void>;
}
export interface FieldChanges { fields?: Record<string, JsonValue>; update?: Record<string, JsonValue> }

export async function validateFieldChanges(raw: unknown, metadata: readonly EditableField[], options: FieldValidationOptions): Promise<FieldChanges> {
  let input: FieldChanges;
  try { input = z.strictObject({ fields: record.optional(), update: record.optional() }).parse(JSON.parse(canonicalJSON(raw))); }
  catch { reject(); }
  const fields = input.fields ?? {}; const updates = input.update ?? {};
  if (!options.transition && !Object.keys(fields).length && !Object.keys(updates).length) reject();
  if (Object.keys(fields).some((id) => Object.hasOwn(updates, id))) reject();
  const byId = new Map(metadata.map((field) => [field.id, field]));
  const people: Array<{ id: string; field: string }> = [];
  function value(value: JsonValue, field: EditableField, type = field.type, element = false): void {
    if (value === null) { if (element || field.required) reject(); return; }
    if (type === "adf") {
      if (!validAdfDocument(value) || field.required && !(value as { content: JsonValue[] }).content.length) reject();
      return;
    }
    if (type === "array") {
      if (!Array.isArray(value) || !field.items || field.required && !value.length) reject();
      for (const item of value) valueCheck(item, field, field.items, true);
      return;
    }
    if (["string", "date", "datetime"].includes(type)) {
      if (typeof value !== "string" || field.required && !value.trim()) reject();
      if (field.allowedStrings && !field.allowedStrings.includes(value)) reject();
      if (type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) reject();
      if (type === "datetime" && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))) reject();
      return;
    }
    if (type === "number" || type === "integer") { if (typeof value !== "number" || !Number.isFinite(value) || type === "integer" && !Number.isSafeInteger(value)) reject(); return; }
    if (type === "boolean") { if (typeof value !== "boolean") reject(); return; }
    if (["user", "option", "priority", "issuetype", "project", "component", "version", "resolution"].includes(type)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) reject();
      const key = type === "user" ? "accountId" : "id";
      if (Object.keys(value).length !== 1 || typeof value[key] !== "string" || !value[key] || value[key].length > 256) reject();
      if (type === "user") people.push({ id: value[key], field: field.id });
      else if (!field.allowedIds?.includes(value[key])) reject();
      return;
    }
    reject();
  }
  const valueCheck = value;
  for (const id of new Set([...Object.keys(fields), ...Object.keys(updates)])) {
    const field = byId.get(id);
    if (!field || forbidden.has(id.toLowerCase()) || options.restricted.includes(id)) reject();
    if (Object.hasOwn(fields, id)) {
      if (!field.operations.includes("set")) reject(); valueCheck(fields[id]!, field);
    } else {
      const changes = updates[id]; if (!Array.isArray(changes) || !changes.length || changes.length > 100) reject();
      for (const change of changes) {
        if (!change || typeof change !== "object" || Array.isArray(change) || Object.keys(change).length !== 1) reject();
        const [operation, item] = Object.entries(change)[0]!;
        if (!["set", "add", "remove"].includes(operation) || !field.operations.includes(operation)) reject();
        if (operation === "set") valueCheck(item, field);
        else {
          if (field.type !== "array" || !field.items || operation === "remove" && field.required) reject();
          valueCheck(item, field, field.items, true);
        }
      }
    }
  }
  if (options.transition) for (const field of metadata.filter((field) => field.required)) {
    if (forbidden.has(field.id.toLowerCase()) || options.restricted.includes(field.id)) reject();
    if (!Object.hasOwn(fields, field.id) && !Object.hasOwn(updates, field.id)) {
      if (!options.existing || !Object.hasOwn(options.existing, field.id)) reject();
      valueCheck(options.existing[field.id]!, field);
    }
  }
  for (const person of people) await options.validatePerson(person.id, person.field);
  return input;
}
