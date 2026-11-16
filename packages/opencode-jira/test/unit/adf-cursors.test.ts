import { describe, expect, it, vi } from "vitest";
import { adfText } from "../../src/jira/adf.js";
import { Cursors } from "../../src/core/cursors.js";

describe("ADF read view", () => {
  it("retains separators, Unicode, lists, tables and hard breaks", () => {
    const text = (text: string) => ({ type: "text", text });
    const p = (...content: unknown[]) => ({ type: "paragraph", content });
    const result = adfText({ type: "doc", content: [p(text("á🙂"), { type: "hardBreak" }, text("two")), p(), { type: "bulletList", content: [{ type: "listItem", content: [p(text("item"))] }] }, { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [p(text("cell"))] }] }] }, { type: "unsupported", content: [text("unknown")] }] });
    expect(result.text).toContain("á🙂\ntwo\n\n• item\ncell\t\nunknown");
    expect(result.warnings).toHaveLength(1);
  });
  it("[5.6][E03][LE-05] preserves mention identities, including missing text", () => {
    const result = adfText({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "mention", attrs: { id: "abc", text: "@Ana García" } },
      { type: "mention", attrs: { id: "def" } }, { type: "mention", attrs: { text: "@Unknown" } },
    ] }] });
    expect(result.text).toBe("@Ana García@def@Unknown");
    expect(result.mentions).toEqual([{ accountId: "abc", label: "@Ana García" }, { accountId: "def", label: "@def" }]);
    expect(result.warnings).toHaveLength(2);
  });
  it("[5.6][E03][LEC-04] preserves CRLF, code and quotations, with complexity bounds", () => {
    expect(adfText({ type: "doc", content: [{ type: "codeBlock", content: [{ type: "text", text: "a\r\nb" }] }, { type: "blockquote", content: [{ type: "text", text: "quote" }] }] }).text).toBe("a\nb\nquote");
    let nested: unknown = { type: "text", text: "deep" };
    for (let i = 0; i < 60; i++) nested = { type: "paragraph", content: [nested] };
    expect(adfText(nested).warnings).toContain("ADF incompleto o demasiado complejo.");
    expect(adfText({ type: "doc", content: Array.from({ length: 20001 }, () => ({ type: "text", text: "x" })) }).warnings).toContain("ADF incompleto o demasiado complejo.");
  });
});
describe("opaque cursors", () => {
  it("binds scope, expires and detects repeated backend tokens", () => {
    const cursors = new Cursors();
    const scope = cursors.scope(["work", "query"]);
    const id = cursors.next(scope, "backend-token")!;
    expect(id).not.toContain("backend-token");
    expect(() => cursors.get(id, "other")).toThrow();
    expect(() => cursors.next(scope, "backend-token", cursors.get(id, scope))).toThrow();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600001);
    expect(() => cursors.get(id, scope)).toThrow();
    vi.restoreAllMocks();
    cursors.close();
    expect(() => cursors.get(id, scope)).toThrow();
  });
});
