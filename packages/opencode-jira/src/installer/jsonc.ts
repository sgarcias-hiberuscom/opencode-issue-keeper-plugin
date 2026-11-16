import { applyEdits, modify, parseTree, getNodeValue, type Node, type ParseError } from "jsonc-parser";

export function parseDocument(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !root || root.type !== "object") throw new Error("Configuración JSONC inválida; no se ha modificado.");
  function check(node: Node) {
    if (node.type === "object") {
      const keys = node.children?.map((property) => property.children?.[0]?.value) ?? [];
      if (new Set(keys).size !== keys.length) throw new Error("JSONC con claves duplicadas; resuelva la ambigüedad.");
    }
    node.children?.forEach(check);
  }
  check(root);
  return getNodeValue(root) as Record<string, unknown>;
}
export function edit(text: string, path: (string | number)[], value: unknown): string {
  return applyEdits(text, modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" } }));
}
