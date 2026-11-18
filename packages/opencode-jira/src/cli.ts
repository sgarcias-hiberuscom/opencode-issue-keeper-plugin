#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { IssueKeeperError } from "./errors.js";
import { check, install, uninstall, type InstallerIO } from "./installer/index.js";
import { reviewProposal } from "./state/review.js";
import { LocalId } from "./core/proposals.js";
import { inspectProposal, installedConfiguration, summarizeExecutions, verifyRecorded } from "./state/operator.js";
import { statePaths, userDataDirectory } from "./state/paths.js";
import { StateError } from "./state/errors.js";

export function parseArguments(args: string[]) {
  const [command, ...rest] = args;
  const proposalCommand = ["review", "status", "verify"].includes(command ?? "");
  if (!["install", "check", "uninstall", "review", "status", "verify"].includes(command ?? "") || !rest.includes("--global")) throw new Error("Uso: issuekeeper-jira install --global [--source local|archivo.tgz] | check --global | uninstall --global | review|verify --global --proposal ID | status --global [--proposal ID]");
  const allowed = command === "install" ? ["--global", "--source"] : proposalCommand ? ["--global", "--proposal"] : ["--global"];
  let source: string | undefined;
  let proposalId: string | undefined;
  let global = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!allowed.includes(arg)) throw new Error("Argumento desconocido; no se ha realizado ningún cambio.");
    if (arg === "--global") { if (global) throw new Error("Argumento duplicado."); global = true; }
    else if (arg === "--proposal") {
      if (proposalId !== undefined || !LocalId.safeParse(rest[i + 1]).success) throw new Error("--proposal requiere un identificador válido.");
      proposalId = rest[++i]!;
    } else {
      if (source !== undefined || !rest[i + 1] || rest[i + 1]!.startsWith("--")) throw new Error("--source requiere un único origen.");
      source = rest[++i]!;
    }
  }
  if (command === "install" && !source) source = "registry";
  if (proposalCommand && command !== "status" && !proposalId) throw new Error("--proposal es obligatorio.");
  return { command: command!, source, ...(proposalId ? { proposalId } : {}) };
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
    const { command, source, proposalId } = parseArguments(args);
    if (command === "status") {
      if (!proposalId && !existsSync(statePaths(userDataDirectory()).directory)) {
        io.print("Todavía no hay ejecuciones registradas; el estado se crea al preparar la primera propuesta.");
        return 1;
      }
      io.print(JSON.stringify(proposalId ? await inspectProposal(proposalId) : summarizeExecutions(), null, 2));
      return 0;
    }
    if (command === "verify") {
      if (!stdin.isTTY || !stdout.isTTY) throw new IssueKeeperError("FORBIDDEN", "La comprobación operativa requiere una terminal local.");
      io.print(JSON.stringify(await verifyRecorded(proposalId!, await installedConfiguration(), { authorizeDownload: async (plan, id) => {
        if (!await io.accept(`Verificar SHA-256 remoto de ${plan.account}/issue/${plan.issueKey}/attachment/${id}. Se descargarán bytes para hash, sin guardarlos ni abrirlos; no se enviarán mutaciones.`)) throw new IssueKeeperError("FORBIDDEN", "Descarga de verificación no autorizada.");
      } }), null, 2)); return 0;
    }
    if (command === "review") {
      if (!stdin.isTTY || !stdout.isTTY) throw new IssueKeeperError("FORBIDDEN", "La revisión requiere una terminal humana; no admite --yes ni entrada por tubería.");
      await reviewProposal(proposalId!, { print: io.print, readHash: async () => {
        const prompt = createInterface({ input: stdin, output: stdout });
        try { return await prompt.question("SHA-256 de la vista completa (vacío cancela): "); } finally { prompt.close(); }
      } });
      return 0;
    }
    if (command === "check") return await check(io);
    if (command === "install") await install(source!, io);
    else await uninstall(io);
    return 0;
  } catch (error) {
    if (error instanceof Error && error.constructor === Error && !("code" in error)) io.print(error.message);
    // IssueKeeperError messages are designed to be user-safe (the tools return
    // them as-is); other coded errors may embed paths or remote data, so stay silent.
    if (error instanceof IssueKeeperError) io.print(error.message);
    if (error instanceof StateError) {
      io.print(error.message);
      io.print("Conserve las copias del paquete y runtime. Consulte status --global --proposal ID y, para recibos confirmados, verify; no borre locks ni edite la base para reintentar.");
    }
    io.print("Operación no completada. Revise argumentos, conflictos, permisos y progreso; no se muestran datos de configuración.");
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1]).catch(() => resolve(process.argv[1]!))).href) {
  process.exitCode = await main();
}
