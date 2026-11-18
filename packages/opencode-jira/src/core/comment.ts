import { parseMarkdown, markdownLimits } from "./markdown.js";
import type { JsonValue } from "./proposals.js";
import { IssueKeeperError } from "../errors.js";

export interface PublicationMention { start: number; end: number; accountId: string; displayName: string }
export interface Publication { version: 1; adf: { type: "doc"; version: 1; content: JsonValue[] }; wiki: string; readable: string }
type Node = { type: string; value?: string; depth?: number; ordered?: boolean; start?: number | null; lang?: string | null; meta?: string | null; align?: Array<string | null>; url?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
function unsupported(): never { throw new IssueKeeperError("FORMAT_NOT_SUPPORTED", "El contenido no se puede publicar fielmente en este destino; prepare una alternativa explícita, sin degradación automática."); }
function badRange(): never { throw new IssueKeeperError("VALIDATION_FAILED", "La mención debe abarcar texto visible continuo, sin código, delimitadores, escapes ni destinos de enlace."); }
function escapeWiki(value: string, destination: "platform" | "jsm"): string {
  if (destination === "jsm") {
    for (const match of value.matchAll(/\\+/g)) {
      const next = value[(match.index ?? 0) + match[0].length];
      if (match[0].length === 2 || next !== undefined && /[\[\]{}*_+^~|#!?%()@-]/.test(next)) unsupported();
    }
  }
  return value.replace(/([\[\]{}*_+^~|#!?%()-])/g, "\\$1");
}

export function publication(source: string, format: "plain" | "markdown", mentions: readonly PublicationMention[] = [], destination: "platform" | "jsm" = "platform"): Publication {
  if (!source.trim().length || source.length > markdownLimits.chars) throw new IssueKeeperError("FORMAT_INVALID", "Texto vacío o excesivo.");
  const sorted = [...mentions].sort((a, b) => a.start - b.start);
  let end = 0;
  const split = (p: number) => p > 0 && p < source.length && /[\uD800-\uDBFF]/.test(source[p - 1]!) && /[\uDC00-\uDFFF]/.test(source[p]!);
  for (const mention of sorted) {
    if (!Number.isSafeInteger(mention.start) || !Number.isSafeInteger(mention.end) || mention.start < end || mention.start >= mention.end || mention.end > source.length || split(mention.start) || split(mention.end) || !mention.accountId || !mention.displayName) badRange();
    end = mention.end;
  }
  if (sorted.length > 100) badRange();
  const used = new Set<PublicationMention>();
  function text(value: string, node?: Node): { adf: JsonValue[]; wiki: string; readable: string } {
    const start = node?.position?.start.offset ?? 0; const finish = node?.position?.end.offset ?? source.length;
    const selected = sorted.filter((mention) => mention.start >= start && mention.end <= finish);
    if (selected.length && source.slice(start, finish) !== value) badRange();
    const adf: JsonValue[] = []; let wiki = ""; let readable = ""; let offset = 0;
    const literal = (part: string) => {
      wiki += escapeWiki(part, destination); readable += part;
      for (const [index, line] of part.split(/\r\n|\r|\n/).entries()) { if (index) adf.push({ type: "hardBreak" }); if (line) adf.push({ type: "text", text: line }); }
    };
    for (const mention of selected) {
      const before = value.slice(offset, mention.start - start);
      if (destination === "jsm" && before.endsWith("\\")) unsupported();
      literal(before);
      adf.push({ type: "mention", attrs: { id: mention.accountId, text: mention.displayName } });
      if (destination === "jsm" && !/^[A-Za-z0-9:_-]+$/.test(mention.accountId)) badRange();
      wiki += `[~accountid:${mention.accountId}]`; readable += `@${mention.displayName} [${mention.accountId}]`; offset = mention.end - start; used.add(mention);
    }
    literal(value.slice(offset)); return { adf, wiki, readable };
  }
  function render(node: Node, listPrefix = ""): { adf: JsonValue[]; wiki: string; readable: string } {
    if (node.type === "text") return text(node.value ?? "", node);
    if (node.type === "inlineCode" || node.type === "code") {
      const value = node.value ?? "";
      if (node.meta || node.lang && !/^[a-zA-Z0-9_+-]{1,40}$/.test(node.lang)) unsupported();
      if (destination === "jsm" && (node.type === "code" ? /\{code(?::|\})/i.test(value) : /[\r\n]|\{\{|\}\}/.test(value))) unsupported();
      return { adf: node.type === "code" ? [{ type: "codeBlock", ...(node.lang && /^[a-zA-Z0-9_+-]{1,40}$/.test(node.lang) ? { attrs: { language: node.lang } } : {}), ...(value ? { content: [{ type: "text", text: value }] } : {}) }] : [{ type: "text", text: value, marks: [{ type: "code" }] }], wiki: node.type === "code" ? `{code}\n${value}\n{code}` : `{{${value}}}`, readable: value };
    }
    if (node.type === "break") return { adf: [{ type: "hardBreak" }], wiki: "\\\\", readable: "\n" };
    const children = (node.children ?? []).map((child) => render(child, node.type === "list" ? listPrefix + (node.ordered ? "#" : "*") : listPrefix));
    const inline = ["paragraph", "heading", "strong", "emphasis", "link", "tableCell"].includes(node.type);
    if (destination === "jsm" && inline && children.some((child, index) => index > 0 && children[index - 1]!.wiki.endsWith("\\") && /^[\[\]{}*_+^~|#!?%()@-]/.test(child.wiki))) unsupported();
    const content = children.flatMap((child) => child.adf); const wiki = children.map((child) => child.wiki).join(inline ? "" : "\n\n"); const readable = children.map((child) => child.readable).join(inline ? "" : "\n\n");
    if (node.type === "strong" || node.type === "emphasis" || node.type === "link") {
      if (node.type === "link" && content.some((item) => item && typeof item === "object" && !Array.isArray(item) && item.type === "mention")) unsupported();
      const mark: JsonValue = node.type === "link" ? { type: "link", attrs: { href: node.url! } } : { type: node.type === "strong" ? "strong" : "em" };
      const marked = content.map((item) => { if (!item || typeof item !== "object" || Array.isArray(item)) unsupported(); return item.type === "mention" ? item : { ...item, marks: [...(Array.isArray(item.marks) ? item.marks : []), mark] }; });
      if (destination === "jsm" && node.type === "link" && /[\[\]|\r\n]/.test(node.url!)) unsupported();
      return { adf: marked, wiki: node.type === "link" ? `[${wiki}|${node.url}]` : `${node.type === "strong" ? "*" : "_"}${wiki}${node.type === "strong" ? "*" : "_"}`, readable: node.type === "link" ? `${readable} (${node.url})` : readable };
    }
    if (node.type === "paragraph" || node.type === "heading") return { adf: [{ type: node.type, ...(node.type === "heading" ? { attrs: { level: node.depth ?? 1 } } : {}), content }], wiki: `${node.type === "heading" ? `h${node.depth}. ` : ""}${wiki}`, readable };
    if (node.type === "blockquote") return { adf: [{ type: "blockquote", content }], wiki: `{quote}\n${wiki}\n{quote}`, readable: `> ${readable}` };
    if (node.type === "listItem") {
      if (destination === "jsm" && node.children?.some((child, index) => index > 0 && child.type !== "list")) unsupported();
      return { adf: [{ type: "listItem", content }], wiki: `${listPrefix} ${children.map((child) => child.wiki).join("\n")}`, readable: `• ${readable}` };
    }
    if (node.type === "list") {
      if (destination === "jsm" && node.ordered && node.start !== 1) unsupported();
      return { adf: [{ type: node.ordered ? "orderedList" : "bulletList", ...(node.ordered ? { attrs: { order: node.start ?? 1 } } : {}), content }], wiki: children.map((child) => child.wiki).join("\n"), readable };
    }
    if (node.type === "tableCell") return { adf: [{ type: "tableCell", content: [{ type: "paragraph", content }] }], wiki, readable };
    if (node.type === "tableRow") return { adf: [{ type: "tableRow", content }], wiki: `|${children.map((child) => child.wiki).join("|")}|`, readable: children.map((child) => child.readable).join(" | ") };
    if (node.type === "table") {
      if (node.align?.some(Boolean)) unsupported();
      const rows = content as Array<{ type: string; content: Array<{ type: string; content: JsonValue[] }> }>;
      if (rows[0]) rows[0].content.forEach((cell) => { cell.type = "tableHeader"; });
      const lines = children.map((child, index) => index ? child.wiki : child.wiki.replace(/(^|[^\\])\|/g, "$1||"));
      return { adf: [{ type: "table", attrs: { isNumberColumnEnabled: false, layout: "default" }, content }], wiki: lines.join("\n"), readable };
    }
    if (node.type === "root") return { adf: content, wiki, readable };
    unsupported();
  }
  const result = format === "plain" ? (() => { const result = text(source); return { ...result, adf: [{ type: "paragraph", content: result.adf }] }; })() : render(parseMarkdown(source).ast as unknown as Node);
  if (used.size !== sorted.length) badRange();
  return { version: 1, adf: { type: "doc", version: 1, content: result.adf }, wiki: result.wiki, readable: result.readable };
}
