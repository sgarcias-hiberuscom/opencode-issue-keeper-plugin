# IssueKeeper Jira — base y lectura

Plugin privado de servidor **OpenCode V2**. Ocho herramientas de lectura y
descarga local; ninguna preparación, carga, transición o escritura remota.
La implementación y las evidencias no equivalen al cierre de la fase:
véase [estado y trazabilidad](../../validation/phase-1.md).

## Instalar

Requiere Node >=22, npm y `tar`; la descarga segura requiere Linux.

```bash
npm --prefix packages/opencode-jira ci
npm --prefix packages/opencode-jira run build
npm --prefix packages/opencode-jira run install:global
```

Desde un tarball ya construido:

```bash
npm exec --package=/ruta/issuekeeper-opencode-jira-0.1.0.tgz -- issuekeeper-jira install --global --source /ruta/issuekeeper-opencode-jira-0.1.0.tgz
```

El instalador muestra el plan y requiere aceptación en una terminal interactiva.
No hay aprobación implícita ni `--yes`. Sin `--source`, informa de que la
instalación desde registro aún no está disponible. No contacta Jira ni lee tokens.

```bash
issuekeeper-jira check --global
issuekeeper-jira uninstall --global
```

Si se ejecutó desde el repositorio, usar `node packages/opencode-jira/dist/cli.js`
en lugar del nombre del binario. No se usa `sudo`, `npm install -g`, ni postinstall.
No se añade el binario al PATH del sistema: para un tarball, volver a usar
`npm exec --package=/ruta/paquete.tgz -- issuekeeper-jira check --global`
o el mismo prefijo con `uninstall --global`.

### Archivos administrados

- Configuración: `$XDG_CONFIG_HOME/opencode`, o `~/.config/opencode`.
- Datos: `$XDG_DATA_HOME/issuekeeper/opencode-jira`, o
  `~/.local/share/issuekeeper/opencode-jira`.
- Copias inmutables por hash en `copies/<sha256>/node_modules/@issuekeeper/opencode-jira`;
  la configuración apunta a una copia completa, nunca a una instalación en curso.
- `instructions/jira.md`, una referencia efectiva en `instructions` y un ejemplo
  **inactivo** `account.example.jsonc`. El ejemplo no se registra como instrucciones.
- Manifiesto y respaldos privados; sin perfiles ni secretos en el manifiesto.

Conserva comentarios JSONC, cuentas, opciones ajenas y orden de permisos.
Si existen ambos archivos de configuración, claves duplicadas, otra vía de carga,
symlinks o un archivo homónimo desconocido, **se detiene para revisión manual**.
No relaja reglas existentes: si una acción ya está cubierta, no añade una regla
posterior que anule su `deny`/`ask`. Las reglas de agentes y políticas administradas
no se modifican.

Las instrucciones personalizadas se conservan y se deja una copia `.new-<hash>`.
Restaurar un archivo o una referencia retirados requiere aceptación explícita.
El progreso permite reanudar una interrupción; un bloqueo de un proceso aún vivo
no se elimina. Una segunda instalación idéntica no reescribe archivos.
La retirada conserva paquetes, respaldos, permisos y personalizaciones; exporta
privadamente las opciones de cuenta antes de retirar su referencia. No revoca tokens.

`check` es de sólo lectura: salida 0 correcta, 1 inconsistente, 2 sin instalación.
No prueba Jira, carga efectiva de OpenCode, modelos, ni políticas de otras capas.
OpenCode recarga la configuración al guardar; `/reload` permite forzar la recarga.

Alternativa manual: integrar [opencode.example.jsonc](./opencode.example.jsonc)
sin reemplazar la configuración existente y registrar
[templates/jira.md](./templates/jira.md) según la sección 9.4 de la especificación.

## Cuentas y secretos

`accounts: []` es válido y registra las ocho herramientas sin red ni permisos.
`jira_accounts_list` devuelve `[]` con indicaciones; las demás herramientas
devuelven `ACCOUNT_UNAVAILABLE` antes de acceder a Jira o pedir permisos remotos.

- Alias explícito en cada operación; `defaultAccount` sólo puede ser un alias existente.
- `restrictedProjects: []` por defecto: bloquea los proyectos enumerados, no permite
  únicamente esos proyectos. Se verifica siempre el proyecto **real**, no el prefijo.
- `restrictedUpdateFields: []` se valida, pero no restringe lecturas en esta fase.
- Las antiguas opciones `allowedProjects`, `allowedReadFields` y
  `allowedUpdateFields` se rechazan.
- Una sola fuente: `tokenFile` absoluto, regular, sin symlink final, del usuario y
  modo 0600 o más restrictivo; o el **nombre** de `tokenEnv` en el proceso servidor.
- La credencial se relee por operación para permitir rotación sin reinicio.
  Se admite un salto de línea final; nunca se pide el token en el chat.
- `cloud-token`: sitio HTTPS `*.atlassian.net`. `cloud-scoped-token`: gateway
  Atlassian con UUID `cloudId`; la conexión compara primero el tenant sin credenciales.
- Ambos usan Basic email:token. Un 401 o credencial inválida sólo afecta al alias.
- `tokenFile` no está soportado en Windows: `ACCOUNT_UNAVAILABLE`.

## Herramientas

| Nombre efectivo | Argumentos |
| --- | --- |
| `jira_accounts_list` | `{}` |
| `jira_connection_test` | `account` |
| `jira_issues_search` | `account`, `jql`, `fields?`, `maxResults?`, `cursor?` |
| `jira_issue_get` | `account`, `issueKey`, `fields?` |
| `jira_comments_list` | `account`, `issueKey`, `audience?`, `maxResults?`, `cursor?` |
| `jira_mention_candidates` | `account`, `issueKey`, `audience`, `query` o `accountId`, `visibility?`, `maxResults?`, `cursor?` |
| `jira_attachments_list` | `account`, `issueKey`, `maxResults?`, `cursor?` |
| `jira_attachment_download` | `account`, `issueKey`, `attachmentId`, `destinationName?` |

Los argumentos son estrictos. No admiten ubicaciones, URLs, cabeceras ni métodos.
Todas las herramientas verifican la sesión y su ubicación canónica desde el
servidor antes de permisos/red. Los rechazos y cancelaciones de OpenCode se
propagan nativamente; los errores de aplicación incluyen `warnings`, `fieldErrors`
cuando proceda, y `meta`. `TIMEOUT` sólo corresponde al temporizador interno.
Una línea JSON en stderr correlaciona `requestId`, herramienta, alias, operación,
último estado HTTP, intentos y duración. No registra cuerpos, cabeceras ni URLs.

### JQL y minimización

```json
{"account":"trabajo","jql":"project = IK AND statusCategory != Done ORDER BY updated DESC","maxResults":25}
```

JQL es la única modalidad. El analizador acotado admite comparaciones, funciones,
listas, paréntesis, AND/OR/NOT y ORDER BY. Rechaza sintaxis desconocida y consultas
sin una cláusula conjuntiva útil de proyecto, asignado o fechas. Por ejemplo,
`assignee = currentUser() OR updated > -1d` requiere acotar más.
Con restricciones envuelve toda la condición y añade `project NOT IN (...)`
antes del orden. Un resultado restringido se omite con advertencia, sin sus datos.

Una página, sin total inventado; cursor opaco de diez minutos, 100 páginas por
cadena y 1000 cursores. Repetir cuenta, JQL, campos y tamaño al continuar.
Búsqueda mínima: summary, status, assignee, project, updated, labels.
Campos personalizados explícitos sin lista configurada; se rechazan `*all`,
`comment`, `attachment` y `worklog`. Se piden siempre project/updated/summary/status.
Usuarios sin emails/avatares; campos personalizados saneados recursivamente.
ADF conserva identidades de menciones y separadores, con avisos por pérdida o
complejidad. El truncamiento es explícito y nunca rompe el JSON.

### JSM y personas

Los tickets software/business siguen usando Platform aunque el perfil active JSM.
Un service desk sin solicitud accesible no recurre a Platform para eludir audiencia.
El portal devuelve `source: "jsm-request"` sin inventar `updated` ni `status.id`;
Platform conserva ambos obligatorios.

Comentarios JSM: audiencia internal/public por comentario. Sus menciones de texto
todavía no tienen codificación verificada; se advierte sin inferir identidades.
Adjuntos JSM: `unknown` si la API no declara audiencia.

Los candidatos usan búsqueda contextual, nunca un directorio global; público
recorre informador, Platform y participantes en páginas por origen. Se mantienen
homónimos e identidades, no emails. `query`: 2–100 caracteres; `accountId` excluyente.
`visibility: {type: "role"|"group", value}` sólo para ticket. Interno o visibilidad
restringida se marca `unverified`; `validated` sólo acredita el origen contextual,
**no autoriza una publicación**. Una identidad puede repetirse entre páginas de
orígenes distintos: deduplicar por `accountId`. Un vacío no prueba inexistencia.

### Permisos y descargas

| Acción | Recurso |
| --- | --- |
| `jira.accounts` | `*` |
| `jira.read` | `alias/connection`, `alias/search`, `alias/issue/KEY` |
| `jira.read` (candidatos) | `alias/issue/KEY/mentions/audience`, además de la lectura del ticket |
| `jira.download` | `alias/issue/KEY/attachment/ID/ruta-relativa` |
| `edit` | destino y temporal relativos; `save` sólo contiene el destino |

También se autoriza la clave canónica si difiere. La sesión se vuelve a validar
tras la aprobación de descarga. Nunca se permiten raíces externas, por lo que no
es necesaria una aprobación `external_directory`.

Se verifica pertenencia por listado y metadata Platform antes del contenido.
Linux `/proc/self/fd`, recorrido con descriptores/O_NOFOLLOW, directorios privados,
temporal exclusivo 0600, streaming con tamaño/SHA-256, publicación sin sobrescribir
y limpieza sólo del temporal propio. El recibo incluye sitio, vía, nombre remoto,
MIME, audiencia y ruta relativa del servidor. No abre ni entrega bytes al modelo.
`downloadDir` y `uploadRoots` deben estar dentro de la ubicación, fuera de secretos.

Platform pide `redirect=false`. Se rechaza **todo 3xx**, JSON o binario, con
`REDIRECT_NOT_ALLOWED` no reintentable. No hay destinos de medios observados y
autorizados; una instalación que necesite 303 **no queda validada funcionalmente**.
Nunca se sigue ni se muestra la URL firmada.

## Límites y decisiones

Predeterminados compartidos en `src/defaults.ts`: 20 s HTTP, 3 intentos, 1 MiB JSON,
3 concurrentes por alias y un tope compartido de **3 por sitio** (ambos toman
`maxConcurrentPerAccount`); el backoff libera ambos permisos. Salida 25/100 y
12000 caracteres; adjuntos 20 MiB, 120 s, `overwrite: false` como único valor.
Binarios sin reintentos. `changes` y opciones de carga no activan escritura.

Decisiones D-01…D-16: JQL único; sin destinos de medios; concurrencia alias+sitio;
unión de ticket por source; proveedor con cuenta resuelta/callback y recibo de
descarga tipado; query/accountId excluyentes y validación contextual; diagnóstico stderr
porque el SDK 2.2.5 no ofrece logger en su Context; cancelación nativa; códigos
CURSOR_INVALID/INVALID_RESPONSE/REDIRECT_NOT_ALLOWED documentados; recursos de la
tabla; omisión avisada de resultados restringidos; projectTypeKey para Platform;
GET JSM servicedesk de bajo coste; tokenFile Windows no soportado; overwrite sólo
false; comandos sincronizados con 9.3.

## Pruebas y pendientes

```bash
npm run typecheck
npm run test:mock
npm run test:pack
npm run build
node scripts/versions.mjs
```

Informes separados en `reports/mock/` y `reports/live/`, excluidos de Git y del
tarball. CI declara Node 22/24, vigencia del esquema, artefactos y job aislado del
instalador. La matriz declarada no es evidencia de su ejecución.

Para integración real, preparar fuera del repositorio opciones e inventario con
el contrato de `test/integration/inventory-read.test.ts`, dos sitios y ambas
modalidades de token:

```bash
ISSUEKEEPER_LIVE_READS=1 \
ISSUEKEEPER_LIVE_DOWNLOADS=1 \
ISSUEKEEPER_LIVE_CONFIG=/ruta/privada/options.json \
ISSUEKEEPER_LIVE_INVENTORY=/ruta/privada/inventory.json npm run test:live
```

Permisos instrumentados del SDK, no una demostración de su política en servidor.
El workflow manual requiere configurar y proteger el entorno `jira-integration`
y sus secretos; nunca se activa desde pull requests ni forks.

Controlador local sin Jira: `npm run build` y
`node scripts/lab.mjs HT-01`…`HT-08`. Variantes: HT-02 código HTTP;
HT-03 `cancel`; HT-04 `redirect`/`large`; HT-05 `restricted`; HT-06 `redirect`.
Usa identidades ficticias y transporte inyectado; no equivale a observación real.

Pendientes de validación: campaña manual, dos proyectos/modelos y políticas reales,
ambas identidades JSM, scopes, cabecera Accept binaria y destinos de medios;
rotación real de token; campaña completa de disco lleno/fallos de escritura y
hostilidades del filesystem. No hay barrido de temporales huérfanos ni cuota
de disco (ADJ-04), ni división completa de cloud.ts (ARQ-05).
El instalador no verifica todos los archivos transitivos contra un inventario de
integridad; conflictos complejos de migración requieren revisión manual.

Excluir `.issuekeeper/` de Git y del contexto en otros proyectos. Los permisos
0700 no aíslan procesos maliciosos del mismo UID: se requiere separación del host.
Dependencias fijadas: SDK 2.2.5, Zod 4.6.7, jsonc-parser 3.3.1. npm audit mantiene
21 avisos moderados transitivos; no se fuerzan actualizaciones incompatibles.
Uso interno, sin publicación ni licencia de distribución elegida.
