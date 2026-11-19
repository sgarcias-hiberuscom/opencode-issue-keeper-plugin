import { describe, expect, it } from "vitest";
import { sameADF, sameField, sameVisibility } from "../../src/jira/changes.js";

describe("[AT-02/03][RC-03] Jira field verification semantics", () => {
  it.each(["labels", "components", "fixVersions", "versions"])("compares %s as an unordered collection without losing elements", (field) => {
    const a = field === "labels" ? "a" : { id: "1" }; const b = field === "labels" ? "b" : { id: "2" };
    expect(sameField(field, [a, b], [b, a])).toBe(true);
    expect(sameField(field, [a], [b, a])).toBe(false);
    expect(sameField(field, [a, a], [b, a])).toBe(false);
    expect(sameField(field, [], null)).toBe(false);
    expect(sameField(field, null, [])).toBe(false);
  });
  it("normalizes Jira option objects without accepting another option", () => {
    expect(sameField("components", [{ id: "1", name: "Server" }, { id: "2", name: "API" }], [{ id: "2" }, { id: "1" }])).toBe(true);
    expect(sameField("components", [{ id: "3" }], [{ id: "1" }])).toBe(false);
  });
  it("does not reorder ADF content, custom arrays or scalar values", () => {
    const a = { type: "text", text: "a" }; const b = { type: "text", text: "b" };
    expect(sameField("description", { type: "doc", content: [a, b] }, { type: "doc", content: [b, a] })).toBe(false);
    expect(sameField("customfield_10000", ["a", "b"], ["b", "a"])).toBe(false);
    expect(sameField("summary", "a", "b")).toBe(false);
  });
  it.each(["description", "environment"])("recognizes only an actually empty ADF document as cleared %s", (field) => {
    const empty = { type: "doc", version: 1, content: [] };
    expect(sameField(field, empty, null)).toBe(true);
    expect(sameField(field, null, empty)).toBe(true);
    expect(sameField(field, null, null)).toBe(true);
    expect(sameField(field, undefined, null)).toBe(false);
    expect(sameField(field, "", null)).toBe(false);
    expect(sameField(field, [], null)).toBe(false);
    expect(sameField(field, { ...empty, content: [{ type: "paragraph", content: [{ type: "text", text: "retained" }] }] }, null)).toBe(false);
  });
  it("does not infer an ADF field from a malformed remote response alone", () => {
    const empty = { type: "doc", version: 1, content: [] };
    expect(sameField("priority", empty, null)).toBe(false);
    expect(sameField("customfield_10000", empty, null)).toBe(false);
    expect(sameField("customfield_10000", empty, null, { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "previous" }] }] })).toBe(true);
  });
});

describe("[CM-09][RC-03] resolved comment visibility", () => {
  it.each(["role", "group"])("accepts only matching %s visibility with optional server identifier", (type) => {
    const expected = { type, value: "Team" };
    expect(sameVisibility({ ...expected, identifier: "server-identifier" }, expected)).toBe(true);
    expect(sameVisibility(expected, expected)).toBe(true);
    expect(sameVisibility({ type, value: "Other", identifier: "server-identifier" }, expected)).toBe(false);
    expect(sameVisibility({ type: type === "role" ? "group" : "role", value: "Team" }, expected)).toBe(false);
    expect(sameVisibility(null, expected)).toBe(false);
    expect(sameVisibility({ ...expected, public: true }, expected)).toBe(false);
    expect(sameVisibility({ ...expected, identifier: 42 }, expected)).toBe(false);
    expect(sameVisibility({ ...expected, identifier: "" }, expected)).toBe(false);
    expect(sameVisibility(expected, undefined)).toBe(false);
  });
  it("keeps unrestricted visibility distinct from any restriction", () => {
    expect(sameVisibility(null, undefined)).toBe(true);
    expect(sameVisibility(undefined, undefined)).toBe(true);
    expect(sameVisibility({}, undefined)).toBe(false);
  });
  it("requires the pinned group identifier, not just its mutable name", () => {
    const expected = { type: "group", value: "Team", identifier: "stable-group" };
    expect(sameVisibility(expected, expected)).toBe(true);
    expect(sameVisibility({ type: "group", value: "Team" }, expected)).toBe(false);
    expect(sameVisibility({ ...expected, identifier: "replacement" }, expected)).toBe(false);
    expect(sameVisibility({ type: "role", value: "Team", identifier: "stable-group" }, expected)).toBe(false);
  });
});

describe("[CM-03/06][RC-03] resolved ADF mention verification", () => {
  const mention = { type: "mention", attrs: { id: "person", text: "Ana" } };
  const text = { type: "text", text: "hello" };
  const doc = (content: unknown[]) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content }] });
  it("ignores only server-resolved mention label/access metadata", () => {
    expect(sameADF(doc([text, mention]), doc([text, { ...mention, attrs: { id: "person", text: "@Ana", accessLevel: "" } }]))).toBe(true);
  });
  it("treats empty node attributes as absent, including table cells and ADF fields", () => {
    const expected = doc([{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [text] }] }] }] }]);
    const actual = JSON.parse(JSON.stringify(expected, (key, value) => value?.type === "tableCell" ? { ...value, attrs: {} } : value));
    expect(sameADF(expected, actual)).toBe(true);
    expect(sameField("description", expected, actual)).toBe(true);
    expect(sameADF(doc([text]), doc([{ ...text, attrs: { unexpected: true } }]))).toBe(false);
  });
  it.each(["identity", "position", "count", "marks", "attribute", "literal"])("does not hide a changed %s", (change) => {
    const altered = structuredClone(mention) as { type: string; attrs: Record<string, string>; marks?: unknown[] };
    if (change === "identity") altered.attrs.id = "another";
    if (change === "marks") altered.marks = [{ type: "strong" }];
    if (change === "attribute") altered.attrs.unexpected = "not ignored";
    const actual = change === "position" ? doc([altered, text]) : change === "count" ? doc([text, altered, altered]) : change === "literal" ? doc([text, { type: "text", text: "@Ana" }]) : doc([text, altered]);
    expect(sameADF(doc([text, mention]), actual)).toBe(false);
  });
});
