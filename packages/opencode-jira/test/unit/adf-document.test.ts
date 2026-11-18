import { describe, expect, it } from "vitest";
import { validAdfDocument } from "../../src/core/adf-document.js";
import { normalizeMetadata, validateFieldChanges } from "../../src/core/metadata.js";
import { publication } from "../../src/core/comment.js";
import { attachmentLinkId } from "../../src/jira/attachment-links.js";
import { config } from "../helpers.js";
import type { JsonValue } from "../../src/core/proposals.js";

describe("[M3][MET-03][AT-05] structural ADF and contextual values", () => {
  it.each([{}, { type: "text" }, { type: "text", text: "" }, { type: "paragraph", content: [{ type: "banana" }] }, { type: "paragraph", content: [{ type: "text", text: "x", attrs: { id: "unknown" } }] }, { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "file:///secret" } }] }] }, { type: "listItem", content: [] }, { type: "heading", attrs: { level: 9 }, content: [] }])("rejects malformed or privileged nodes %j", (node) => {
    expect(validAdfDocument({ type: "doc", version: 1, content: [node as JsonValue] })).toBe(false);
  });
  it.each(["# Título\n\nPárrafo **fuerte** *énfasis* [enlace](https://example.com)", "- uno\n  - dos", "| a | b |\n|---|---|\n| c | d |", "> cita\n\n```js\nx()\n```", "1. uno\n2. dos", "a  \nb"])("accepts structurally valid output of the fixed converter: %s", (source) => {
    expect(validAdfDocument(publication(source, "markdown").adf)).toBe(true);
  });
  it("rejects string options from another context", async () => {
    const metadata = normalizeMetadata({ fields: { customfield_1: { name: "Opción", required: false, schema: { type: "string" }, operations: ["set"], allowedValues: ["a", "b"] } } });
    const options = { restricted: [], validatePerson: async () => {} };
    await expect(validateFieldChanges({ fields: { customfield_1: "c" } }, metadata, options)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(validateFieldChanges({ fields: { customfield_1: "a" } }, metadata, options)).resolves.toBeDefined();
  });
});

describe("[M3][UP-03][HTTP-01] extract attachment IDs without following links", () => {
  it.each(["https://evil.invalid/rest/api/3/attachment/123", "https://example.atlassian.net/rest/api/3/attachment/123?token=secret", "https://example.atlassian.net/rest/api/3/attachment/123#fragment", "https://person@example.atlassian.net/rest/api/3/attachment/123", "https://example.atlassian.net/other/rest/api/3/attachment/123", "https://example.atlassian.net/rest/api/3/attachment/0", "javascript:alert(1)"])("rejects manipulated remote references without exposing them", (link) => {
    expect(() => attachmentLinkId(config().accounts[0]!, link)).toThrow("Respuesta Jira no válida");
  });
  it("accepts direct site and exact scoped gateway references", () => {
    const account = config().accounts[0]!; account.auth = { ...account.auth, mode: "cloud-scoped-token", cloudId: "11111111-2222-4333-8444-555555555555" };
    expect(attachmentLinkId(account, `${account.siteUrl}/rest/api/2/attachment/123`)).toBe("123");
    expect(attachmentLinkId(account, `https://api.atlassian.com/ex/jira/${account.auth.cloudId}/rest/api/3/attachment/123`)).toBe("123");
    expect(() => attachmentLinkId(account, "https://api.atlassian.com/ex/jira/other/rest/api/3/attachment/123")).toThrow();
  });
});
