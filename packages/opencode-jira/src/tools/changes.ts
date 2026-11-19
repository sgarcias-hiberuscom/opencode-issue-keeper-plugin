import { relative } from "node:path";
import type { Service } from "../core/service.js";
import { resolveChangeScope } from "../core/scope.js";
import { operations } from "../core/operation.js";
import type { HttpClient } from "../http.js";
import type { ChangeContext } from "../state/application.js";
import type { ChangeRuntime } from "../state/runtime.js";
import { operatorSummary } from "../state/operator.js";
import { JiraChangeAdapter } from "../jira/changes.js";
import { JiraPreparation } from "../jira/preparation.js";
import { nativeChangePermissions } from "./change-permissions.js";
import { nativePermit, toolRegistrar, type Context, type Execution } from "./shared.js";
import * as schemas from "./change-schemas.js";

export async function registerChanges(ctx: Context, service: Service, http: HttpClient, runtime: ChangeRuntime, options: { data?: string } = {}): Promise<void> {
  function dependencies(execution: Execution, account?: string) {
    const context: ChangeContext = { sessionID: execution.sessionID, signal: execution.signal, resolve: async () => resolveChangeScope(execution.sessionID, () => ctx.session.get({ sessionID: execution.sessionID }), service.location), onAccount: (account) => { const operation = operations.getStore(); if (operation) operation.account = account; } };
    const read = async (issueKey: string) => { if (account) await nativePermit(ctx, execution, "jira.read", [`${account}/issue/${issueKey}`]); };
    const preparation = new JiraPreparation(service.config, http, service.location, read);
    const adapter = new JiraChangeAdapter(() => service.config, http, async (issueKey) => {
      // Apply resolves its alias only from the persisted, context-checked plan.
      if (account) await read(issueKey);
    }, { ...options, authorizeDownload: async (plan, id) => nativePermit(ctx, execution, "jira.download", [`${plan.account}/issue/${plan.issueKey}/attachment/${id}/verify`], { purpose: "SHA-256 del archivo publicado, sin abrir ni guardar contenido" }) });
    const ports = { validate: async (...args: Parameters<typeof adapter.validate>) => {
      const [plan] = args;
      if (!account) await nativePermit(ctx, execution, "jira.read", [`${plan.account}/issue/${plan.issueKey}`]);
      return adapter.validate(...args);
    }, send: adapter.send.bind(adapter), verify: adapter.verify.bind(adapter), ...nativeChangePermissions(ctx, execution) };
    return { context, preparation, ports };
  }
  await ctx.tool.transform((editor) => {
    const add = toolRegistrar(editor, ctx, service, true);
    add("issue_edit_metadata", "Consultar campos y operaciones editables del ticket, excluyendo restricciones locales. No autoriza escribir.", schemas.EditMetadataInput, async (input, execution) => { const d = dependencies(execution, input.account); return { data: await d.preparation.metadata(input, d.context) }; });
    add("transitions_list", "Consultar transiciones reales y requisitos del workflow. No escribir status como campo ni inventar IDs.", schemas.TransitionsInput, async (input, execution) => { const d = dependencies(execution, input.account); return { data: await d.preparation.metadata(input, d.context, true) }; });
    function prepare(kind: "fields" | "comment" | "transition" | "upload", input: Parameters<JiraPreparation["prepare"]>[1], execution: Execution) {
      const d = dependencies(execution, input.account);
      return runtime.prepareGenerated((store, context) => d.preparation.prepare(kind, input, store, context, async (path) => {
        await nativePermit(ctx, execution, "read", [relative(service.location, path)], { purpose: "Copia privada de carga Jira; no abrir contenido al modelo" });
      }), d.context, d.ports).then((saved) => ({ data: { ...operatorSummary(saved), expiresAt: saved.plan.expiresAt, review: `issuekeeper-jira review --global --proposal ${saved.plan.id}`, files: saved.plan.files.map(({ stagedRef: _, ...file }) => file), notificationDelivery: "unknown" }, warnings: ["Propuesta preparada, no publicada. Revise íntegramente antes de aplicar; allow no acredita una decisión humana nueva."] }));
    }
    add("issue_update_prepare", "Preparar atributos con fecha real y metadata, sin mutación. fields reemplaza; update admite operaciones validadas. No embeber comentarios, status ni adjuntos.", schemas.UpdatePrepareInput, (input, execution) => prepare("fields", input, execution));
    add("comment_prepare", "Preparar comentario con audience obligatoria, plain por defecto o Markdown soportado; mentions son IDs validados y rangos UTF-16 de texto visible. No publica ni degrada formato. visibility sólo Platform. Esta preparación valida la audiencia y el acceso de cada mención y devuelve MENTION_NOT_ALLOWED si una persona no puede mencionarse: prepárese con la persona elegida por el usuario aunque los candidatos figuren como unverified.", schemas.CommentPrepareInput, (input, execution) => prepare("comment", input, execution));
    add("transition_prepare", "Preparar una transición obtenida de transitions_list, con fecha real y campos requeridos. No cambia estado todavía.", schemas.TransitionPrepareInput, (input, execution) => prepare("transition", input, execution));
    add("attachment_upload_prepare", "Preparar copias privadas autorizadas, fijadas por hash, desde uploadRoots. No transmite temporales. audience explícita. Comentario opcional sólo JSM, publicado una sola vez con adjuntos; no repetir con comment_prepare.", schemas.UploadPrepareInput, (input, execution) => prepare("upload", input, execution));
    add("change_apply", "Aplicar sólo proposalId guardado en esta sesión/ubicación; una propuesta de otra sesión o ubicación devuelve PROPOSAL_INVALID y no se puede aplicar aquí. Requiere revisión íntegra por CLI y permiso nativo jira.write del hash exacto. Cuando el usuario pida aplicar o publicar, llama directamente: el servidor comprueba el registro de la revisión y devuelve FORBIDDEN si falta; no pidas al usuario confirmación adicional de la revisión ni la compruebes por tu cuenta. Tras una denegación o un fallo, la aplicación queda failed: no reenvíes ese ID ni ofrezcas hacerlo; prepara una propuesta nueva si el usuario insiste. No reintenta mutaciones. Parcial/desconocido: consultar status/verify; no preparar duplicados ni cambiar de cuenta.", schemas.ApplyInput, async (input, execution) => {
      const d = dependencies(execution); const saved = await runtime.apply(input.proposalId, d.context, d.ports);
      return { account: saved.plan.account, data: { ...operatorSummary(saved), notificationDelivery: "unknown" } };
    });
  });
}
