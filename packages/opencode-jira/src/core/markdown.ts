import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import type { Root } from "mdast";
import type { Node, Parent } from "unist";
import { IssueKeeperError } from "../errors.js";

export const markdownLimits = Object.freeze({ chars: 100000, nodes: 10000, depth: 32 });
const supported = new Set(["root", "paragraph", "text", "heading", "break", "emphasis", "strong", "inlineCode", "code", "blockquote", "list", "listItem", "link", "table", "tableRow", "tableCell"]);
export interface MarkdownDocument { source: string; ast: Root }

export function parseMarkdown(source: string): MarkdownDocument {
  if (typeof source !== "string" || !source.length || source.length > markdownLimits.chars) throw new IssueKeeperError("FORMAT_INVALID", "El texto Markdown está vacío o supera el límite de tamaño.");
  let ast: Root;
  try { ast = fromMarkdown(source, { extensions: [gfmTable()], mdastExtensions: [gfmTableFromMarkdown()] }); }
  catch { throw new IssueKeeperError("FORMAT_INVALID", "El documento Markdown no se puede analizar."); }
  if (!ast.children.length) throw new IssueKeeperError("FORMAT_INVALID", "El documento Markdown no contiene contenido publicable.");
  let count = 0;
  const pending: Array<{ node: Node; depth: number }> = [{ node: ast, depth: 0 }];
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > markdownLimits.nodes || depth > markdownLimits.depth) throw new IssueKeeperError("FORMAT_INVALID", "El documento Markdown supera los límites de complejidad.");
    if (!supported.has(node.type)) throw new IssueKeeperError("FORMAT_NOT_SUPPORTED", "Markdown contiene elementos no admitidos; no se publicará una versión degradada.");
    const start = node.position?.start.offset; const end = node.position?.end.offset;
    if (start === undefined || end === undefined || start < 0 || end < start || end > source.length) throw new IssueKeeperError("FORMAT_INVALID", "El analizador no conservó las posiciones de la fuente.");
    if (node.type === "link") {
      try { const url = new URL((node as { url?: string }).url ?? ""); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(); }
      catch { throw new IssueKeeperError("FORMAT_NOT_SUPPORTED", "Sólo se admiten enlaces HTTP/HTTPS sin credenciales."); }
    }
    if ("children" in node) for (const child of (node as Parent).children) pending.push({ node: child, depth: depth + 1 });
  }
  return { source, ast };
}
