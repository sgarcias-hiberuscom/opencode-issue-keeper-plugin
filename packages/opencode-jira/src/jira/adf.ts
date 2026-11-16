import type { Mention } from "../core/ticket.js";

export function adfText(value: unknown): { text: string; warnings: string[]; mentions: Mention[] } {
  const warnings = new Set<string>();
  const mentions: Mention[] = [];
  let count = 0;
  function visit(node: unknown, depth: number): string {
    if (!node || typeof node !== "object" || depth > 50 || ++count > 20000) {
      warnings.add("ADF incompleto o demasiado complejo."); return "";
    }
    const n = node as Record<string, unknown>;
    if (n.type === "text") return typeof n.text === "string" ? n.text.replace(/\r\n?/g, "\n") : "";
    if (n.type === "hardBreak") return "\n";
    if (n.type === "mention") {
      const attrs = n.attrs as Record<string, unknown> | undefined;
      const accountId = typeof attrs?.id === "string" && attrs.id.length ? attrs.id : undefined;
      const label = typeof attrs?.text === "string" && attrs.text.length ? attrs.text : undefined;
      if (!accountId) warnings.add("Mención sin identidad verificable.");
      if (!label) warnings.add("Mención sin texto legible; se muestra su identidad si existe.");
      const text = label ? (label.startsWith("@") ? label : `@${label}`) : accountId ? `@${accountId}` : "[mención no verificable]";
      if (accountId) mentions.push({ accountId, label: text });
      return text;
    }
    const known = ["doc", "paragraph", "heading", "bulletList", "orderedList", "listItem", "codeBlock", "blockquote", "table", "tableRow", "tableCell", "tableHeader", "rule"];
    if (!known.includes(String(n.type))) warnings.add("ADF contiene nodos no soportados; la vista de texto puede omitir contenido.");
    const children = Array.isArray(n.content) ? n.content.map((child) => visit(child, depth + 1)).join("") : "";
    if (n.type === "listItem") return `• ${children.trimEnd()}\n`;
    if (["tableCell", "tableHeader"].includes(String(n.type))) return `${children.trimEnd()}\t`;
    return children + (["paragraph", "heading", "codeBlock", "tableRow", "blockquote", "rule"].includes(String(n.type)) ? "\n" : "");
  }
  return { text: value == null ? "" : visit(value, 0).trimEnd(), warnings: [...warnings], mentions };
}
