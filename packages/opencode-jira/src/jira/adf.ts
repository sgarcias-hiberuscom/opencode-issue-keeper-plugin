export function adfText(value: unknown): { text: string; warnings: string[] } {
  const warnings = new Set<string>();
  let count = 0;
  function visit(node: unknown, depth: number): string {
    if (!node || typeof node !== "object" || depth > 50 || ++count > 20000) {
      warnings.add("ADF incompleto o demasiado complejo."); return "";
    }
    const n = node as Record<string, unknown>;
    if (n.type === "text") return typeof n.text === "string" ? n.text : "";
    if (n.type === "hardBreak") return "\n";
    if (n.type === "mention") return typeof (n.attrs as Record<string, unknown> | undefined)?.text === "string" ? String((n.attrs as Record<string, unknown>).text) : "[mención]";
    const known = ["doc", "paragraph", "heading", "bulletList", "orderedList", "listItem", "codeBlock", "blockquote", "table", "tableRow", "tableCell", "tableHeader", "rule"];
    if (!known.includes(String(n.type))) warnings.add("ADF contiene nodos no soportados; la vista de texto puede omitir contenido.");
    const children = Array.isArray(n.content) ? n.content.map((child) => visit(child, depth + 1)).join("") : "";
    if (n.type === "listItem") return `• ${children.trimEnd()}\n`;
    if (["tableCell", "tableHeader"].includes(String(n.type))) return `${children.trimEnd()}\t`;
    return children + (["paragraph", "heading", "codeBlock", "tableRow", "blockquote", "rule"].includes(String(n.type)) ? "\n" : "");
  }
  return { text: value == null ? "" : visit(value, 0).trimEnd(), warnings: [...warnings] };
}
