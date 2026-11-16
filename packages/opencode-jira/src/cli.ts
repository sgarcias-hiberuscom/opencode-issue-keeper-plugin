#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { check, install, uninstall, type InstallerIO } from "./installer/index.js";

export function parseArguments(args: string[]) {
  const [command, ...rest] = args;
  if (!["install", "check", "uninstall"].includes(command ?? "") || !rest.includes("--global")) throw new Error("Uso: issuekeeper-jira install --global --source local|archivo.tgz | check --global | uninstall --global");
  const allowed = command === "install" ? ["--global", "--source"] : ["--global"];
  let source: string | undefined;
  let global = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!allowed.includes(arg)) throw new Error("Argumento desconocido; no se ha realizado ningún cambio.");
    if (arg === "--global") { if (global) throw new Error("Argumento duplicado."); global = true; }
    else {
      if (source !== undefined || !rest[i + 1] || rest[i + 1]!.startsWith("--")) throw new Error("--source requiere un único origen.");
      source = rest[++i]!;
    }
  }
  if (command === "install" && !source) throw new Error("La instalación desde registro no está disponible; use --source local o un tarball .tgz.");
  return { command: command!, source };
}
export async function main(args = process.argv.slice(2), io: InstallerIO = {
  print: (message) => console.log(message),
  accept: async (plan) => {
    console.log(plan);
    if (!stdin.isTTY || !stdout.isTTY) return false;
    const prompt = createInterface({ input: stdin, output: stdout });
    try { return /^(s|si|sí|y|yes)$/i.test((await prompt.question("¿Aceptar este plan? [s/N] ")).trim()); }
    finally { prompt.close(); }
  },
}): Promise<number> {
  try {
    const { command, source } = parseArguments(args);
    if (command === "check") return await check(io);
    if (command === "install") await install(source!, io);
    else await uninstall(io);
    return 0;
  } catch (error) {
    if (error instanceof Error && error.constructor === Error && !("code" in error)) io.print(error.message);
    io.print("Operación no completada. Revise argumentos, conflictos, permisos y progreso; no se muestran datos de configuración.");
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1]).catch(() => resolve(process.argv[1]!))).href) {
  process.exitCode = await main();
}
