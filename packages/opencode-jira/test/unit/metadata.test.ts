import { describe, expect, it, vi } from "vitest";
import { normalizeMetadata, offeredFields, validateFieldChanges } from "../../src/core/metadata.js";

const raw = { fields: {
  summary: { name: "Resumen", required: true, schema: { type: "string" }, operations: ["set"] },
  labels: { name: "Etiquetas", required: false, schema: { type: "array", items: "string" }, operations: ["set", "add", "remove"] },
  priority: { name: "Prioridad", required: false, schema: { type: "priority" }, operations: ["set"], allowedValues: [{ id: "2", name: "Alta" }] },
  assignee: { name: "Asignado", required: false, schema: { type: "user" }, operations: ["set"] },
  comment: { name: "Comentario", required: true, schema: { type: "string" }, operations: ["set"] },
  customfield_1: { name: "Número", required: false, schema: { type: "number" }, operations: ["set"] },
} };
const metadata = normalizeMetadata(raw);
function options() { return { restricted: [] as string[], validatePerson: vi.fn(async () => {}) }; }
describe("[MET-01/02][AT-03–AT-07][TR-03] contextual metadata and field operations", () => {
  it("normalizes only relevant metadata and excludes prohibited/restricted offerings", () => {
    expect(offeredFields(metadata, ["summary"]).map((field) => field.id)).not.toContain("summary");
    expect(offeredFields(metadata, []).map((field) => field.id)).not.toContain("comment");
    expect(offeredFields(metadata, ["summary"], true).filter((field) => field.required).map((field) => field.id)).toEqual(["summary", "comment"]);
    expect(metadata.find((field) => field.id === "priority")!.allowedIds).toEqual(["2"]);
  });
  it("preserves set/add/remove, null and empty arrays without rewriting the payload", async () => {
    for (const input of [{ fields: { summary: "nuevo", labels: [] } }, { fields: { assignee: null } }, { update: { labels: [{ add: "uno" }, { remove: "dos" }] } }]) {
      expect(await validateFieldChanges(input, metadata, options())).toEqual(input);
    }
  });
  it.each([
    {}, { fields: {} }, { fields: { unknown: "x" } }, { fields: { status: "done" } }, { fields: { comment: "hidden" } },
    { fields: { summary: null } }, { fields: { summary: "" } }, { fields: { labels: "x" } }, { fields: { labels: [1] } },
    { fields: { customfield_1: "1" } }, { fields: { priority: { id: "other-context" } } }, { fields: { priority: { name: "Alta" } } },
    { fields: { assignee: { displayName: "Nombre" } } }, { fields: { summary: "x" }, update: { summary: [{ set: "y" }] } },
    { update: { summary: [{ add: "x" }] } }, { update: { labels: [{ add: ["x"] }] } }, { update: { labels: [{ add: "x", remove: "y" }] } },
    { update: { labels: [] } }, { fields: { summary: "x" }, transition: { id: "1" } },
  ])("rejects incompatible inputs atomically %#", async (input) => {
    const o = options(); await expect(validateFieldChanges(input, metadata, o)).rejects.toMatchObject({ code: "VALIDATION_FAILED" }); expect(o.validatePerson).not.toHaveBeenCalled();
  });
  it("rejects an entire edit containing a policy-restricted field", async () => {
    await expect(validateFieldChanges({ fields: { summary: "x", labels: [] } }, metadata, { ...options(), restricted: ["labels"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("requires independent contextual assignment validation for explicit account IDs", async () => {
    const o = options(); await validateFieldChanges({ fields: { assignee: { accountId: "person" } } }, metadata, o);
    expect(o.validatePerson).toHaveBeenCalledWith("person", "assignee"); const original = new Error("not assignable"); o.validatePerson.mockRejectedValue(original);
    await expect(validateFieldChanges({ fields: { assignee: { accountId: "person" } } }, metadata, o)).rejects.toBe(original);
  });
  it("does not hide required workflow fields even when their policy makes transition impossible", async () => {
    await expect(validateFieldChanges({ fields: { summary: "x" } }, metadata, { ...options(), transition: true })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const workflow = metadata.filter((field) => field.id !== "comment");
    await expect(validateFieldChanges({}, workflow, { ...options(), transition: true, existing: { summary: "existing" } })).resolves.toEqual({});
    await expect(validateFieldChanges({}, workflow, { ...options(), restricted: ["summary"], transition: true, existing: { summary: "existing" } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it.each([null, { fields: [] }, { fields: { summary: { required: true } } }])("rejects malformed remote metadata %#", (input) => {
    expect(() => normalizeMetadata(input)).toThrow();
  });
});
