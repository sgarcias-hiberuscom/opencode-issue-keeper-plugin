import { constants } from "node:fs";
import { open, readdir, unlink, lstat } from "node:fs/promises";
import { join, matchesGlob, resolve } from "node:path";
import { z } from "zod";
import { parseConfig } from "../config.js";
import { baseOptions, basePermissions } from "../defaults.js";
import { atomicWrite, hash, privateDirectory, readOptional, removeUnchanged, safeAncestors } from "./files.js";
import { edit, parseDocument } from "./jsonc.js";
import { packageName, preparePackage, validatePackage, validateDependencies } from "./package.js";
import { installerPaths, type InstallerPaths } from "./paths.js";

const Rule = z.strictObject({ action: z.string(), resource: z.string(), effect: z.enum(["allow", "ask", "deny"]) });
const Manifest = z.strictObject({
  version: z.string(), installed: z.string(), config: z.string(),
  previousInstalled: z.string().optional(),
  progress: z.enum(["prepared", "instructions", "configured", "complete", "removed"]),
  pluginCreated: z.boolean(), instructionCreated: z.boolean(),
  files: z.array(z.strictObject({ path: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) })),
  permissions: z.array(Rule),
});
type Manifest = z.infer<typeof Manifest>;
export interface InstallerIO { accept: (plan: string) => Promise<boolean>; print: (message: string) => void }
export interface InstallerOptions {
  paths?: InstallerPaths;
  prepare?: typeof preparePackage;
  afterStep?: (step: Manifest["progress"]) => Promise<void>;
}

async function configuration(paths: InstallerPaths) {
  const json = join(paths.config, "opencode.json");
  const jsonc = join(paths.config, "opencode.jsonc");
  const [a, b] = await Promise.all([readOptional(json), readOptional(jsonc)]);
  if (a !== undefined && b !== undefined) throw new Error("Existen opencode.json y opencode.jsonc; elija uno antes de continuar.");
  const path = a !== undefined ? json : jsonc;
  const original = a ?? b;
  const text = original ?? "{\n}\n";
  return { path, original, text, value: parseDocument(text) };
}

function array(value: unknown, name: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Campo ${name} incompatible; requiere revisión manual.`);
  return value;
}
function isPlugin(value: unknown): boolean {
  const reference = typeof value === "string" ? value : value && typeof value === "object" && "package" in value ? value.package : "";
  return typeof reference === "string" && (reference.includes(packageName) || /(?:^|[/\\])opencode-jira(?:[/\\]|$)/.test(reference) || reference.includes("issuekeeper.jira"));
}
function instructionMatches(reference: unknown, target: string, paths: InstallerPaths): boolean {
  return typeof reference === "string" && (reference === target || matchesGlob(target, resolve(paths.config, reference)));
}
async function manifest(paths: InstallerPaths): Promise<{ text?: string; value?: Manifest }> {
  const text = await readOptional(paths.manifest);
  if (text === undefined) return {};
  const parsed = Manifest.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error("Manifiesto inválido; no se retirará ni sobrescribirá contenido.");
  const value = parsed.data;
  const allowedFiles = (path: string) => [paths.instructions, paths.example].some((base) => path === base
    || path.startsWith(`${base}.new-`) && /^[a-f0-9]{16}$/.test(path.slice(`${base}.new-`.length)));
  const digest = value.installed.slice(join(paths.data, "copies").length + 1).split("/")[0] ?? "";
  const validInstallation = (path: string) => {
    const id = path.slice(join(paths.data, "copies").length + 1).split("/")[0] ?? "";
    return /^[a-f0-9]{64}$/.test(id) && path === join(paths.data, "copies", id, "node_modules", packageName);
  };
  if (![join(paths.config, "opencode.json"), join(paths.config, "opencode.jsonc")].includes(value.config)
    || !/^[a-f0-9]{64}$/.test(digest)
    || value.installed !== join(paths.data, "copies", digest, "node_modules", packageName)
    || value.previousInstalled !== undefined && !validInstallation(value.previousInstalled)
    || value.files.some((file) => !allowedFiles(file.path))) throw new Error("Rutas de manifiesto no reconocidas.");
  return { text, value };
}

async function discovery(paths: InstallerPaths): Promise<void> {
  const directory = join(paths.config, "plugins");
  await safeAncestors(directory);
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  if (entries.some((name) => /jira|issuekeeper/i.test(name))) throw new Error("Posible plugin Jira descubierto automáticamente; revise su migración antes de instalar.");
}

async function withLock<T>(paths: InstallerPaths, run: () => Promise<T>): Promise<T> {
  await privateDirectory(paths.data);
  const lockPath = join(paths.data, "installer.lock");
  let lock;
  async function acquire() {
    const handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify({ owner: "issuekeeper-jira", pid: process.pid }));
    return handle;
  }
  try { lock = await acquire(); }
  catch {
    const content = await readOptional(lockPath);
    const info = content ? z.strictObject({ owner: z.literal("issuekeeper-jira"), pid: z.number().int().positive() }).safeParse(JSON.parse(content)) : undefined;
    const stat = await lstat(lockPath);
    if (!info?.success || stat.uid !== process.getuid?.()) throw new Error("Bloqueo de origen desconocido; revise installer.lock manualmente.");
    try { process.kill(info.data.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH" && await readOptional(lockPath) === content) {
        await unlink(lockPath);
        lock = await acquire();
      }
    }
    if (!lock) throw new Error("Otra instalación está activa; no se modificará.");
  }
  try { return await run(); }
  finally { await lock.close(); await unlink(lockPath); }
}

export async function install(source: string, io: InstallerIO, options: InstallerOptions = {}): Promise<void> {
  const paths = options.paths ?? installerPaths();
  return withLock(paths, async () => {
    const config = await configuration(paths);
    const previous = await manifest(paths);
    await discovery(paths);
    const plugins = array(config.value.plugins, "plugins");
    const indexes = plugins.flatMap((entry, index) => isPlugin(entry) ? [index] : []);
    if (indexes.length > 1) throw new Error("Hay varias referencias a Jira; requiere migración revisada.");
    const index = indexes[0];
    if (index !== undefined && (!previous.value || typeof plugins[index] !== "object" || plugins[index] === null
      || ![previous.value.installed, ...(previous.value.progress !== "complete" ? [previous.value.previousInstalled] : [])].includes((plugins[index] as { package?: string }).package))) {
      throw new Error("Ya existe otra referencia al plugin; revise su migración sin duplicarla.");
    }
    const existing = index === undefined ? undefined : plugins[index] as { package: string; options?: unknown };
    const parsed = existing ? parseConfig(existing.options) : parseConfig(baseOptions());
    const instructionRefs = array(config.value.instructions, "instructions");
    if (instructionRefs.filter((ref) => instructionMatches(ref, paths.instructions, paths)).length > 1) throw new Error("Instrucciones duplicadas; resuélvalas antes de continuar.");
    if (previous.value && ["complete", "removed"].includes(previous.value.progress) && (index === undefined || !instructionRefs.some((ref) => instructionMatches(ref, paths.instructions, paths)) || await readOptional(paths.instructions) === undefined)) {
      if (!await io.accept("Se retiró una referencia o jira.md. ¿Restaurar explícitamente los elementos administrados?")) throw new Error("Restauración no aceptada; sin cambios.");
    }
    const prepared = await (options.prepare ?? preparePackage)(source, paths.data);
    let text = config.text;
    if (!config.value.$schema) text = edit(text, ["$schema"], "https://opencode.ai/config.json");
    if (index === undefined) text = edit(text, ["plugins"], [...plugins, { package: prepared.installed, options: baseOptions() }]);
    else {
      text = edit(text, ["plugins", index, "package"], prepared.installed);
      const raw = existing!.options as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (!(key in raw)) text = edit(text, ["plugins", index, "options", key], value);
        else if (["http", "output", "changes", "attachments"].includes(key)) {
          for (const [child, setting] of Object.entries(value as Record<string, unknown>)) {
            if (!(child in (raw[key] as object))) text = edit(text, ["plugins", index, "options", key, child], setting);
          }
        }
      }
    }
    const instructionAlreadyPresent = instructionRefs.some((ref) => instructionMatches(ref, paths.instructions, paths));
    if (!instructionAlreadyPresent) text = edit(text, ["instructions"], [...instructionRefs, paths.instructions]);
    const rules = array(config.value.permissions, "permissions");
    if (!rules.every((rule) => Rule.safeParse(rule).success)) throw new Error("Reglas de permisos incompatibles; no se modificarán.");
    const added = basePermissions.filter((rule) => !rules.some((existing) => matchesGlob(rule.action, (existing as z.infer<typeof Rule>).action)));
    if (added.length) text = edit(text, ["permissions"], [...rules, ...added]);
    if (rules.length) io.print("Permisos existentes conservados: no se relaja allow/ask/deny. Revise la política efectiva y las reglas de agentes.");
    const files: Manifest["files"] = [...(previous.value?.files ?? [])];
    const writes: { path: string; content: string; original?: string }[] = [];
    for (const [target, name] of [[paths.instructions, "jira.md"], [paths.example, "account.example.jsonc"]]) {
      const template = (await readOptional(join(prepared.installed, "templates", name!)))!;
      if (template === undefined) throw new Error("Plantilla ausente.");
      const original = await readOptional(target!);
      const known = previous.value?.files.find((file) => file.path === target);
      if (original !== undefined && (!known || hash(original) !== known.hash)) {
        if (!known) throw new Error("Archivo de instrucciones o ejemplo de origen desconocido; no se sobrescribe ni se registra.");
        const comparison = `${target}.new-${hash(template).slice(0, 16)}`;
        const comparisonOld = await readOptional(comparison);
        if (comparisonOld !== undefined && comparisonOld !== template) throw new Error("La comparación existente se ha personalizado; consérvela antes de continuar.");
        writes.push({ path: comparison, content: template, original: comparisonOld });
        if (!files.some((file) => file.path === comparison)) files.push({ path: comparison, hash: hash(template) });
        io.print("Plantilla personalizada conservada; se ofrece una copia .new para comparar.");
      } else {
        writes.push({ path: target!, content: template, original });
        const recorded = files.find((file) => file.path === target);
        if (recorded) recorded.hash = hash(template);
        else files.push({ path: target!, hash: hash(template) });
      }
    }
    const next: Manifest = {
      version: prepared.version, installed: prepared.installed, config: config.path, progress: "complete",
      pluginCreated: previous.value?.pluginCreated ?? index === undefined,
      instructionCreated: previous.value?.instructionCreated ?? !instructionAlreadyPresent,
      files, permissions: [...(previous.value?.permissions ?? []), ...added],
    };
    const complete = `${JSON.stringify(next, null, 2)}\n`;
    if (text === config.text && writes.every((file) => file.original === file.content) && previous.text === complete) {
      io.print("Instalación sin diferencias."); return;
    }
    const permissionPlan = added.map((rule) => `  ${rule.action} ${rule.resource}: ${rule.effect}`).join("\n") || "  Sin reglas nuevas; se conservan las existentes.";
    if (!await io.accept(`Instalar ${packageName} ${prepared.version}\nOrigen: ${source === "local" ? "local" : "tarball"}\nPaquete: ${prepared.installed}\nConfiguración: ${config.path}\nInstrucciones: ${paths.instructions}\nCambios mínimos JSONC; plantillas, referencia al plugin y ${added.length} reglas nuevas:\n${permissionPlan}\nSe conservarán las cuentas y las opciones existentes.`)) throw new Error("Plan no aceptado; configuración e instrucciones sin cambios.");
    if (await readOptional(config.path) !== config.original || await readOptional(paths.manifest) !== previous.text) throw new Error("Edición concurrente detectada; repita el plan.");
    for (const file of writes) if (await readOptional(file.path) !== file.original) throw new Error("Una plantilla cambió durante la revisión.");
    let journal = previous.text;
    async function progress(step: Manifest["progress"]) {
      const content = `${JSON.stringify({ ...next, ...(step !== "complete" && existing ? { previousInstalled: existing.package } : {}), progress: step }, null, 2)}\n`;
      await atomicWrite(paths.manifest, content, journal); journal = content;
      await options.afterStep?.(step);
    }
    await progress("prepared");
    for (const file of writes) await atomicWrite(file.path, file.content, file.original, join(paths.data, "backups"));
    await progress("instructions");
    io.print("Paquete instalado; instrucciones preparadas.");
    await atomicWrite(config.path, text, config.original, join(paths.data, "backups"));
    await progress("configured");
    await progress("complete");
    io.print("Instrucciones registradas; configuración preparada.");
    if (!parsed.accounts.length) io.print("Falta configurar al menos una cuenta desde account.example.jsonc; no comparta el token en el chat.");
    io.print("OpenCode recarga la configuración al guardar. Ejecute check --global; no comprueba conectividad Jira.");
  });
}

export async function check(io: Pick<InstallerIO, "print">, paths = installerPaths()): Promise<number> {
  try {
    const config = await configuration(paths);
    const recorded = await manifest(paths);
    if (!recorded.value) { io.print("No hay instalación administrada. No se comprueba conectividad Jira."); return 2; }
    const m = recorded.value;
    if (m.progress !== "complete") throw new Error("Instalación incompleta o retirada; revise el progreso del manifiesto.");
    await validatePackage(m.installed, m.version);
    const root = m.installed.slice(0, -`/node_modules/${packageName}`.length);
    await validateDependencies(root);
    for (const dep of ["@opencode/plugin", "zod", "jsonc-parser"]) {
      if (await readOptional(join(root, "node_modules", dep, "package.json")) === undefined) throw new Error("Dependencias incompletas.");
    }
    const entries = array(config.value.plugins, "plugins").filter(isPlugin);
    if (entries.length !== 1 || (entries[0] as { package?: unknown }).package !== m.installed) throw new Error("Referencia al plugin ausente o duplicada.");
    const refs = array(config.value.instructions, "instructions");
    if (refs.filter((ref) => instructionMatches(ref, paths.instructions, paths)).length !== 1 || await readOptional(paths.instructions) === undefined) throw new Error("jira.md o su referencia falta o está duplicada.");
    await discovery(paths);
    const options = parseConfig((entries[0] as { options?: unknown }).options);
    io.print(`Instalación completa ${m.version}. Cuentas configuradas: ${options.accounts.length}. Opciones globales y permisos presentes; perfiles y secretos omitidos.`);
    io.print(`HTTP: ${options.http.timeoutMs} ms, ${options.http.readMaxAttempts} intentos, ${options.http.maxConcurrentPerAccount} concurrentes por alias y sitio. Salida: ${options.output.pageSize}/${options.output.maxPageSize}, ${options.output.maxTextChars} caracteres. Adjuntos: ${options.attachments.enabled ? "habilitados" : "deshabilitados"}, ${options.attachments.maxFileBytes} bytes, overwrite=false.`);
    io.print("No comprueba conectividad con Jira ni sustituye una invocación real de las herramientas.");
    return 0;
  } catch (error) {
    io.print(error instanceof Error && !error.name.includes("Syntax") ? error.message : "No se pudo validar la instalación.");
    return 1;
  }
}

export async function uninstall(io: InstallerIO, paths = installerPaths()): Promise<void> {
  return withLock(paths, async () => {
    const recorded = await manifest(paths);
    if (!recorded.value || recorded.value.progress === "removed") { io.print("No hay elementos administrados pendientes de retirada."); return; }
    if (recorded.value.progress !== "complete") throw new Error("Manifiesto incompleto; reanude la instalación antes de retirar referencias.");
    const m = recorded.value;
    const config = await configuration(paths);
    const plugins = array(config.value.plugins, "plugins");
    const indexes = plugins.flatMap((entry, index) => isPlugin(entry) && (entry as { package?: unknown })?.package === m.installed ? [index] : []);
    if (indexes.length > 1) throw new Error("Referencias compartidas o duplicadas; requiere revisión manual.");
    const index = indexes[0];
    const entry = index === undefined ? undefined : plugins[index] as { options?: unknown };
    const accounts = entry ? parseConfig(entry.options).accounts : [];
    const exportPath = join(paths.data, "preserved-options.json");
    const exportOld = await readOptional(exportPath);
    if (accounts.length && exportOld !== undefined) throw new Error("Ya existe preserved-options.json; consérvelo en otro lugar antes de exportar cuentas.");
    let text = config.text;
    if (index !== undefined && m.pluginCreated) text = edit(text, ["plugins", index], undefined);
    const references = array(config.value.instructions, "instructions");
    const remainingPlugins = array(parseDocument(text).plugins, "plugins");
    const shared = remainingPlugins.some(isPlugin) || references.some((ref) => (ref !== paths.instructions || !m.instructionCreated) && instructionMatches(ref, paths.instructions, paths));
    if (m.instructionCreated && !shared) {
      for (let i = references.length - 1; i >= 0; i--) if (references[i] === paths.instructions) text = edit(text, ["instructions", i], undefined);
    }
    // Existing permission order is retained; rules with uncertain ownership are never removed.
    if (!await io.accept(`Retirar sólo referencias y plantillas intactas administradas.\nConfiguración: ${config.path}\n${accounts.length ? `Conservar opciones de cuenta en exportación privada: ${exportPath}\n` : ""}Se conservan permisos read/edit, copias del paquete, respaldos, descargas y personalizaciones. No revoca tokens.`)) throw new Error("Retirada no aceptada.");
    if (await readOptional(config.path) !== config.original || await readOptional(paths.manifest) !== recorded.text) throw new Error("Edición concurrente detectada.");
    if (accounts.length && m.pluginCreated) await atomicWrite(exportPath, `${JSON.stringify(entry, null, 2)}\n`, undefined);
    await atomicWrite(config.path, text, config.original, join(paths.data, "backups"));
    if (!shared) {
      for (const file of m.files) await removeUnchanged(file.path, file.hash);
    }
    await atomicWrite(paths.manifest, `${JSON.stringify({ ...m, progress: "removed" }, null, 2)}\n`, recorded.text);
    io.print("Referencias administradas retiradas. Se conservan paquetes, permisos y archivos personalizados; no se revocan tokens.");
  });
}
