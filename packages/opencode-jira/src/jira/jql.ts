import { IssueKeeperError } from "../errors.js";

interface Token { value: string; start: number; end: number; quoted: boolean }
export interface ParsedJql { condition: string; orderBy: string; useful: boolean }
function fail(): never { throw new IssueKeeperError("VALIDATION_FAILED", "JQL no analizable con seguridad; acote por proyecto, persona asignada o fechas usando una condición conjuntiva."); }

export function parseJql(input: string): ParsedJql {
  if (!input.trim() || input.length > 10000 || /[\x00-\x1f\x7f]/.test(input)) fail();
  const tokens: Token[] = [];
  const lex = /\s+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|!=|!~|>=|<=|[=~><(),]|[A-Za-z_][A-Za-z0-9_.\[\]-]*|-[0-9]+[mhdwMy]?|[0-9]+/gy;
  let at = 0;
  while (at < input.length) {
    lex.lastIndex = at;
    const match = lex.exec(input);
    if (!match) fail();
    const value = match[0]; at = lex.lastIndex;
    if (!value.trim()) continue;
    tokens.push({ value, start: match.index, end: at, quoted: /^["']/.test(value) });
    if (tokens.length > 2000) fail();
  }
  let pos = 0;
  const is = (word: string) => !tokens[pos]?.quoted && tokens[pos]?.value.toUpperCase() === word;
  const take = (word: string) => { if (!is(word)) fail(); pos++; };
  function value(depth: number): void {
    if (depth > 40) fail();
    const token = tokens[pos++];
    if (!token || ["AND", "OR", "NOT", "ORDER", "BY", "IS", "IN", ")", "(", ","].includes(token.value.toUpperCase()) && !token.quoted) fail();
    if (!token.quoted && !/^(?:[A-Za-z_][\w.[\]-]*|-[0-9]+[mhdwMy]?|[0-9]+)$/.test(token.value)) fail();
    if (is("(")) {
      if (token.quoted || !/^[A-Za-z_]\w*$/.test(token.value)) fail();
      pos++;
      if (!is(")")) {
        value(depth + 1);
        while (is(",")) { pos++; value(depth + 1); }
      }
      take(")");
    }
  }
  function atom(depth: number): boolean {
    if (depth > 40) fail();
    if (is("NOT")) { pos++; atom(depth + 1); return false; }
    if (is("(")) { pos++; const useful = expression(depth + 1); take(")"); return useful; }
    const field = tokens[pos++];
    if (!field || (!field.quoted && !/^[A-Za-z_][\w.[\]-]*$/.test(field.value))) fail();
    let op = tokens[pos++]?.value.toUpperCase();
    if (op === "NOT") { take("IN"); op = "NOT IN"; }
    if (op === "IN" || op === "NOT IN") {
      take("("); value(depth + 1);
      while (is(",")) { pos++; value(depth + 1); }
      take(")");
    } else if (op === "IS") {
      if (is("NOT")) pos++;
      if (!is("EMPTY") && !is("NULL")) fail();
      pos++;
    } else {
      if (!op || !["=", "!=", "~", "!~", ">", ">=", "<", "<="].includes(op)) fail();
      value(depth + 1);
    }
    const name = field.value.replace(/^["']|["']$/g, "").toLowerCase();
    return (["project", "assignee"].includes(name) && ["=", "IN", "IS"].includes(op!))
      || (["created", "updated", "resolved", "resolutiondate", "duedate"].includes(name) && ["=", ">", ">=", "<", "<="].includes(op!));
  }
  function conjunction(depth: number): boolean {
    let useful = atom(depth);
    while (is("AND")) { pos++; const right = atom(depth); useful ||= right; }
    return useful;
  }
  function expression(depth: number): boolean {
    let useful = conjunction(depth);
    let disjunction = false;
    while (is("OR")) { pos++; conjunction(depth); disjunction = true; }
    if (disjunction) useful = false;
    return useful;
  }
  const useful = expression(0);
  const end = tokens[pos]?.start ?? input.length;
  if (is("ORDER")) {
    pos++; take("BY");
    for (;;) {
      const field = tokens[pos++];
      if (!field || !field.quoted && !/^[A-Za-z_][\w.[\]-]*$/.test(field.value)) fail();
      if (is("ASC") || is("DESC")) pos++;
      if (!is(",")) break;
      pos++;
    }
  }
  if (pos !== tokens.length) fail();
  return { condition: input.slice(0, end).trim(), orderBy: input.slice(end).trim(), useful };
}

export function restrictedJql(input: string, restrictedProjects: readonly string[], requireUseful = true): string {
  const parsed = parseJql(input);
  if (requireUseful && !parsed.useful) fail();
  if (!restrictedProjects.length) return input;
  return `(${parsed.condition}) AND project NOT IN (${restrictedProjects.map((key) => JSON.stringify(key)).join(", ")})${parsed.orderBy ? ` ${parsed.orderBy}` : ""}`;
}
