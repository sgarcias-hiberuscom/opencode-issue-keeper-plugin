import type { JsonValue } from "./proposals.js";

export function validAdfDocument(input: JsonValue): boolean {
  function object(value: JsonValue | undefined): value is Record<string, JsonValue> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
  function only(value: Record<string, JsonValue>, keys: string[]) { return Object.keys(value).every((key) => keys.includes(key)); }
  function positive(value: JsonValue | undefined) { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
  function mark(value: JsonValue): boolean {
    if (!object(value) || typeof value.type !== "string" || !only(value, ["type", "attrs"])) return false;
    if (["strong", "em", "code"].includes(value.type)) return value.attrs === undefined;
    if (value.type !== "link" || !object(value.attrs) || !only(value.attrs, ["href", "title"]) || typeof value.attrs.href !== "string" || value.attrs.title !== undefined && typeof value.attrs.title !== "string") return false;
    try { const url = new URL(value.attrs.href); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
  }
  const blocks = ["paragraph", "heading", "bulletList", "orderedList", "codeBlock", "blockquote", "table"];
  function node(value: JsonValue, allowed: string[], depth: number): boolean {
    if (depth > 32 || !object(value) || typeof value.type !== "string" || !allowed.includes(value.type) || !only(value, ["type", "version", "text", "content", "marks", "attrs"])) return false;
    const type = value.type;
    if (type === "text") return typeof value.text === "string" && Boolean(value.text.length) && only(value, ["type", "text", "marks"]) && (value.marks === undefined || Array.isArray(value.marks) && value.marks.every(mark));
    if (type === "hardBreak") return only(value, ["type"]);
    if (value.text !== undefined || value.marks !== undefined) return false;
    if (type === "doc" ? value.version !== 1 : value.version !== undefined) return false;
    const attrs = value.attrs;
    if (attrs !== undefined && !object(attrs)) return false;
    if (type === "heading") { if (!object(attrs) || !only(attrs, ["level"]) || !Number.isInteger(attrs.level) || Number(attrs.level) < 1 || Number(attrs.level) > 6) return false; }
    else if (type === "orderedList") { if (attrs !== undefined && (!only(attrs as Record<string, JsonValue>, ["order"]) || !Number.isSafeInteger((attrs as Record<string, JsonValue>).order) || Number((attrs as Record<string, JsonValue>).order) < 0)) return false; }
    else if (type === "codeBlock") { if (object(attrs) && (!only(attrs, ["language"]) || typeof attrs.language !== "string" || attrs.language.length > 100)) return false; }
    else if (type === "table") { if (object(attrs) && (!only(attrs, ["isNumberColumnEnabled", "layout"]) || attrs.isNumberColumnEnabled !== undefined && typeof attrs.isNumberColumnEnabled !== "boolean" || attrs.layout !== undefined && !["default", "wide", "full-width"].includes(String(attrs.layout)))) return false; }
    else if (["tableCell", "tableHeader"].includes(type)) { if (object(attrs) && (!only(attrs, ["colspan", "rowspan", "colwidth"]) || attrs.colspan !== undefined && !positive(attrs.colspan) || attrs.rowspan !== undefined && !positive(attrs.rowspan) || attrs.colwidth !== undefined && attrs.colwidth !== null && (!Array.isArray(attrs.colwidth) || !attrs.colwidth.every(positive)))) return false; }
    else if (attrs !== undefined) return false;
    if (value.content === undefined) return ["paragraph", "heading", "codeBlock"].includes(type);
    if (!Array.isArray(value.content)) return false;
    if (!["doc", "paragraph", "heading", "codeBlock"].includes(type) && !value.content.length) return false;
    const children = type === "doc" || type === "blockquote" ? blocks : type === "paragraph" || type === "heading" ? ["text", "hardBreak"] : type === "codeBlock" ? ["text"] : ["bulletList", "orderedList"].includes(type) ? ["listItem"] : type === "listItem" ? ["paragraph", "bulletList", "orderedList", "codeBlock", "blockquote"] : type === "table" ? ["tableRow"] : type === "tableRow" ? ["tableHeader", "tableCell"] : ["paragraph", "bulletList", "orderedList", "codeBlock", "blockquote"];
    if (type === "listItem" && (!object(value.content[0]) || value.content[0].type !== "paragraph")) return false;
    return value.content.every((child) => node(child, children, depth + 1)) && (type !== "codeBlock" || value.content.every((child) => object(child) && child.marks === undefined));
  }
  return node(input, ["doc"], 0);
}
