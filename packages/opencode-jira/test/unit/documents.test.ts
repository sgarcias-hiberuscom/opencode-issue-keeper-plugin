import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "jsonc-parser";
import { z } from "zod";
import { AccountSchema, ConfigSchema, parseConfig } from "../../src/config.js";
import { baseOptions, basePermissions } from "../../src/defaults.js";

const spec = new URL("../../../../doc/plugin-jira-opencode.md", import.meta.url);
const specificationTest = it.skipIf(!existsSync(spec));
async function blockAfter(marker: string, language: string) {
  const text = await readFile(spec, "utf8");
  const start = text.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const content = text.slice(start).match(new RegExp("```" + language + "\\n([\\s\\S]*?)\\n```"))?.[1];
  expect(content).toBeDefined();
  return `${content}\n`;
}
describe("[4.4][E00][CF-01] shared defaults and literal templates", () => {
  specificationTest("keeps the parser, defaults and specification base identical", async () => {
    const base = parse(await blockAfter("#### Configuración base generada", "jsonc"));
    expect(base.plugins[0].options).toEqual(baseOptions());
    expect(parseConfig({ accounts: [] })).toEqual(baseOptions());
    expect(base.permissions).toEqual(basePermissions);
    expect(() => parseConfig({ accounts: [], defaultAccount: "x" })).toThrow();
  });
  specificationTest("validates the literal two-account example", async () => {
    const example = parse(await blockAfter("#### Ejemplo con dos cuentas", "jsonc"));
    expect(parseConfig(example.plugins[0].options).accounts).toHaveLength(2);
  });
  specificationTest("keeps model instructions and the inactive account example synchronized", async () => {
    expect(await readFile(new URL("../../templates/jira.md", import.meta.url), "utf8")).toBe(await blockAfter("#### Contenido de `jira.md`", "markdown"));
    const example = await readFile(new URL("../../templates/account.example.jsonc", import.meta.url), "utf8");
    expect(AccountSchema.parse(parse(example)).readOnly).toBe(true);
    expect(example).toBe(await blockAfter("Su estructura de referencia es:", "jsonc"));
  });
  specificationTest.each(["jira-get", "jira-list", "jira-update"])("keeps %s literal", async (command) => {
    expect(await readFile(new URL(`../../../../.opencode/commands/${command}.md`, import.meta.url), "utf8")).toBe(await blockAfter(`Crear \`.opencode/commands/${command}.md\`:`, "markdown"));
  });
  it("validates the repository example and base permission order", async () => {
    const text = await readFile(new URL("../../opencode.example.jsonc", import.meta.url), "utf8");
    const example = parse(text);
    expect(parseConfig(example.plugins[0].options)).toBeDefined();
    expect(example.permissions).toEqual(basePermissions);
  });
  it("[ARQ-03] keeps core independent of adapters, transport and tool schemas", async () => {
    const directory = new URL("../../src/core/", import.meta.url);
    for (const file of await readdir(directory)) {
      const text = await readFile(new URL(file, directory), "utf8");
      expect(text).not.toMatch(/from ["'](?:\.\.\/)+(?:jira\/|tools\/|http[.])/);
    }
  });
  specificationTest("[RES-03] documents every emitted application error code", async () => {
    const source = await readFile(new URL("../../src/errors.ts", import.meta.url), "utf8");
    const codes = [...source.split("export class")[0]!.matchAll(/"([A-Z_]+)"/g)].map((match) => match[1]!);
    const specification = await readFile(spec, "utf8");
    const table = specification.slice(specification.indexOf("#### Tipos de error"), specification.indexOf("#### Escrituras inciertas"));
    for (const code of codes) expect(table).toContain(code);
    expect(codes).not.toContain("CANCELLED");
  });
  it("[CFG-07] keeps the distributed schema current", async () => {
    const schema = JSON.parse(await readFile(new URL("../../options.schema.json", import.meta.url), "utf8"));
    expect(schema).toEqual(z.toJSONSchema(ConfigSchema, { io: "input", unrepresentable: "any" }));
  });
  it("validates the shipped defaults and inactive account without external documents", async () => {
    expect(parseConfig({ accounts: [] })).toEqual(baseOptions());
    expect(() => parseConfig({ accounts: [], defaultAccount: "missing" })).toThrow();
    const example = await readFile(new URL("../../templates/account.example.jsonc", import.meta.url), "utf8");
    expect(AccountSchema.parse(parse(example)).readOnly).toBe(true);
  });
  it.each(["jira-get", "jira-list", "jira-update"])("ships the exact project command %s independently of the checkout", async (command) => {
    const shipped = await readFile(new URL(`../../templates/commands/${command}.md`, import.meta.url), "utf8");
    expect(shipped).toBe(await readFile(new URL(`../../../../.opencode/commands/${command}.md`, import.meta.url), "utf8"));
    expect(shipped).not.toMatch(/^(?:model|agent):|```(?:sh|bash)|curl /m);
    if (command === "jira-update") {
      expect(shipped).toContain("No invoques jira_change_apply");
      expect(shipped).toContain("expectedUpdated");
    }
  });
});
