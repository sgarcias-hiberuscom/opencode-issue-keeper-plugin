import { describe, expect, it } from "vitest";
import { publication } from "../../src/core/comment.js";

describe("[M3][TXT/MEN][CM-02–08] immutable publication conversion", () => {
  it.each(["plain", "markdown"] as const)("keeps source coordinates through Unicode and CRLF in %s", (format) => {
    const source = "😀 primera\r\nAna y Ana";
    const mentions = [source.indexOf("Ana"), source.lastIndexOf("Ana")].map((start) => ({ start, end: start + 3, accountId: "id:1", displayName: "Ana real" }));
    const output = publication(source, format, mentions, "jsm");
    expect(output.wiki.match(/\[~accountid:id:1\]/g)).toHaveLength(2);
    expect(JSON.stringify(output.adf).match(/"type":"mention"/g)).toHaveLength(2);
    expect(output.readable).toContain("@Ana real [id:1]");
  });
  it("plain preserves punctuation literally and cannot create implicit wiki mentions", () => {
    const output = publication("*hola* [~accountid:person] {code} | _x_ # h", "plain", [], "jsm");
    expect(output.adf.content).toEqual([{ type: "paragraph", content: [{ type: "text", text: "*hola* [~accountid:person] {code} | _x_ # h" }] }]);
    expect(output.wiki).toContain("\\[\\~accountid:person\\]");
  });
  it.each(["plain", "markdown"] as const)("does not escape ordinary periods in %s text or email addresses", (format) => {
    const source = "correo@example.invalid. Texto final.";
    const output = publication(source, format, [], "jsm");
    expect(output.wiki).toBe(source);
    expect(output.readable).toBe(source);
    expect(output.adf.content).toEqual([{ type: "paragraph", content: [{ type: "text", text: source }] }]);
  });
  it("keeps numeric punctuation and literal backslashes without inventing a period escape", () => {
    expect(publication("1. literal\r\n3.14 y \\.", "plain", [], "jsm").wiki).toBe("1. literal\r\n3.14 y \\.");
  });
  it.each(["\\\\.", "\\*", "\\[~accountid:person]", "\\@Ana"])("blocks a JSM literal escape that cannot be represented faithfully: %s", (source) => {
    expect(() => publication(source, "plain", [], "jsm")).toThrowError(expect.objectContaining({ code: "FORMAT_NOT_SUPPORTED" }));
    expect(publication(source, "plain", [], "platform").adf.content).toEqual([{ type: "paragraph", content: [{ type: "text", text: source }] }]);
  });
  it("does not double a literal backslash into a Jira forced line break", () => {
    const source = "Ruta C:\\datos\\archivo.txt y barra \\.";
    expect(publication(source, "plain", [], "jsm").wiki).toBe(source);
    expect(publication("\\\\\\.", "plain", [], "jsm").wiki).toBe("\\\\\\.");
  });
  it.each(["# Título", "**fuerte** *énfasis*", "> cita", "- uno\n  - dos", "1. uno\n2. dos", "[enlace](https://example.com)", "`literal`", "```js\nx()\n```", "a  \nb", "| a | b |\n|---|---|\n| c | d |"])("converts supported structural content: %s", (source) => {
    const result = publication(source, "markdown", [], "jsm");
    expect(result.version).toBe(1); expect(result.adf.content.length).toBeGreaterThan(0); expect(result.wiki).not.toContain("undefined");
    expect(publication(source, "markdown", [], "jsm")).toEqual(result);
  });
  it("emits a hard break without also inserting a physical newline", () => {
    expect(publication("uno  \ndos", "markdown", [], "jsm").wiki).toBe("uno\\\\dos");
  });
  it.each(["<script>x()</script>", "![x](https://example.com/a.png)", "[x](javascript:alert)", "---"])("rejects unsupported syntax without degrading: %s", (source) => {
    expect(() => publication(source, "markdown", [], "jsm")).toThrow();
  });
  it.each(["`Ana`", "```\nAna\n```", "[x](https://example.com/Ana)", "**Ana**"])("rejects ranges touching non-text syntax: %s", (source) => {
    const start = source.indexOf("Ana");
    const range = source.startsWith("**") ? { start: 0, end: source.length } : { start, end: start + 3 };
    expect(() => publication(source, "markdown", [{ ...range, accountId: "person", displayName: "Ana" }])).toThrow();
  });
  it("allows mentions in visible formatted text", () => {
    for (const source of ["**Ana**", "*Ana*"]) {
      const start = source.indexOf("Ana"); const result = publication(source, "markdown", [{ start, end: start + 3, accountId: "person", displayName: "Ana" }]);
      expect(JSON.stringify(result.adf)).toContain('"type":"mention"');
    }
  });
  it.each(["\\Ana", "barra \\\\**Ana**"])("does not let a literal slash escape a generated JSM mention or formatting delimiter: %s", (source) => {
    const format = source.includes("**") ? "markdown" : "plain"; const start = source.indexOf("Ana");
    const mention = { start, end: start + 3, accountId: "person", displayName: "Ana" };
    expect(() => publication(source, format, [mention], "jsm")).toThrowError(expect.objectContaining({ code: "FORMAT_NOT_SUPPORTED" }));
    expect(JSON.stringify(publication(source, format, [mention], "platform").adf)).toContain('"type":"mention"');
  });
  it("rejects mentioned link labels instead of silently losing the link", () => {
    const source = "[Ana](https://example.com)";
    expect(() => publication(source, "markdown", [{ start: 1, end: 4, accountId: "person", displayName: "Ana" }])).toThrow();
  });
  it.each([{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 2 }, { start: -1, end: 2 }, { start: 0, end: 50 }])("rejects invalid/surrogate range %j", (range) => {
    expect(() => publication("😀 Ana", "plain", [{ ...range, accountId: "id", displayName: "Ana" }])).toThrow();
  });
  it("rejects overlaps, excessive mentions and range mapping through escapes", () => {
    expect(() => publication("Ana", "plain", [{ start: 0, end: 3, accountId: "id", displayName: "Ana" }, { start: 1, end: 3, accountId: "id", displayName: "Ana" }])).toThrow();
    expect(() => publication("A\\*na", "markdown", [{ start: 0, end: 5, accountId: "id", displayName: "Ana" }])).toThrow();
  });
  it.each(["a".repeat(100001), "", "> ".repeat(34) + "texto"])("bounds invalid size/complexity", (source) => { expect(() => publication(source, "markdown")).toThrow(); });
  it.each([" ", "\t\r\n", "\u00a0", "\u2003"])("rejects whitespace-only content without silently trimming a valid source: %j", (source) => {
    for (const destination of ["platform", "jsm"] as const) for (const format of ["plain", "markdown"] as const) {
      expect(() => publication(source, format, [], destination)).toThrowError(expect.objectContaining({ code: "FORMAT_INVALID" }));
    }
    expect(publication(" texto \r\n", "plain").readable).toBe(" texto \r\n");
  });
  it("rejects JSM code delimiters that would terminate a literal block", () => { expect(() => publication("```\n{code}\n```", "markdown", [], "jsm")).toThrow(); });
});
