import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../src/core/markdown.js";

describe("[D-10][TXT-01][CM-02–CM-07] pinned parser and original UTF-16 ranges", () => {
  it("keeps exact CRLF and surrogate-pair offsets without normalizing source", () => {
    const source = "😀 antes\r\n\r\n**Persona** y `literal`";
    const parsed = parseMarkdown(source); expect(parsed.source).toBe(source);
    const paragraph = parsed.ast.children[1]!; expect(paragraph.type).toBe("paragraph");
    if (paragraph.type !== "paragraph") throw new Error();
    const strong = paragraph.children[0]!; expect(strong.type).toBe("strong");
    expect(strong.position!.start.offset).toBe(source.indexOf("**Persona**"));
    expect(source.slice(strong.position!.start.offset, strong.position!.end.offset)).toBe("**Persona**");
    if (strong.type !== "strong") throw new Error();
    expect(source.slice(strong.children[0]!.position!.start.offset, strong.children[0]!.position!.end.offset)).toBe("Persona");
  });
  it("parses nested lists, tables, code, emphasis and links without resolving external resources", () => {
    const parsed = parseMarkdown("# Título\n\n- uno\n  - dos\n\n1. primero\n2. segundo\n\n> cita\n\n| A | B |\n| --- | --- |\n| celda | valor |\n\n```js\nconst x = '<img>';\n```\n\n*énfasis* [enlace](https://example.com)");
    expect(parsed.ast.children.map((node) => node.type)).toEqual(["heading", "list", "list", "blockquote", "table", "code", "paragraph"]);
  });
  it.each(["<script>alert(1)</script>", "![imagen](https://evil.invalid)", "[enlace](javascript:alert)", "[enlace](data:text/html,test)", "[archivo](file:///private)", "[nombre][ref]\n\n[ref]: https://example.com"])("does not silently degrade unsupported content %#", (source) => {
    expect(() => parseMarkdown(source)).toThrow();
  });
  it("rejects excessive size/depth and preserves code literally", () => {
    expect(() => parseMarkdown("x".repeat(100001))).toThrow(); expect(() => parseMarkdown("> ".repeat(40) + "texto")).toThrow();
    expect(parseMarkdown("`[~accountid:literal]`\n\n```sh\nrm -rf /\n```").ast.children.map((node) => node.type)).toEqual(["paragraph", "code"]);
  });
});
