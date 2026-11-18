# IssueKeeper Jira — lectura y escritura protegida

Plugin privado de servidor **OpenCode V2**. Quince herramientas: ocho de lectura
y descarga local, metadata/transiciones y preparación/aplicación protegida de
atributos, comentarios Platform/JSM, transiciones y cargas Platform/JSM.
Entrega privada **0.2.1**: implementación protegida y correcciones verificadas de
normalización Jira, visibilidad estable, diagnósticos y espera de aprobación.
Las evidencias y el acta de la campaña REAL/manual de fase 2 se conservan por
separado; no se distribuyen datos privados del laboratorio en el paquete.

## Instalar

Requiere Node >=22, npm y `tar`. La descarga segura y el estado global del
instalador requieren Linux; persistencia validada con Node 22/24 en disco local.

La copia administrada contiene solo la parte de servidor y mantiene el SDK
`@opencode/plugin` 2.2.5. La instalación usa `--legacy-peer-deps` para no resolver
los peers opcionales de TUI/GUI del SDK (Electron, Vite, etc.). No sustituye sus
dependencias normales: se comprueban el árbol instalado contra su lock y la
carga de las quince herramientas sin esos peers de interfaz.

```bash
npm --prefix packages/opencode-jira ci
npm --prefix packages/opencode-jira run build
npm --prefix packages/opencode-jira run install:global
```

Desde un tarball ya construido:

```bash
npm exec --legacy-peer-deps --package=/ruta/issuekeeper-opencode-jira-0.2.0.tgz -- issuekeeper-jira install --global --source /ruta/issuekeeper-opencode-jira-0.2.0.tgz
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
`npm exec --legacy-peer-deps --package=/ruta/paquete.tgz -- issuekeeper-jira check --global`
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
- Estado global privado en `runtime/`, fuera de `copies/` y de los proyectos.

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

### Persistencia global y mantenimiento

El motor SQLite `better-sqlite3` **13.2.0** (MIT, SQLite 3.54.1) se distribuye como
dependencia normal del plugin, con binarios precompilados. No necesita instalar
SQLite en el sistema, compilar módulos, ejecutar scripts de instalación, abrir
puertos ni administrar otro servidor. El instalador conserva `--ignore-scripts`
y comprueba el motor incluido en cada copia antes de activarla. No se usa el
`node:sqlite` experimental. La validación actual cubre Linux x64; otras
plataformas/arquitecturas no se anuncian como probadas.

La base reside en `$XDG_DATA_HOME/issuekeeper/opencode-jira/runtime/changes.sqlite`
(por defecto `~/.local/share/issuekeeper/opencode-jira/runtime/changes.sqlite`),
con directorios 0700 y archivos 0600. Todos los proyectos del mismo usuario del
servidor comparten el dominio de coordinación, **no la autorización**: cada
plan conserva sesión, ubicación, alias, sitio, identidad, ticket y política.
Cambiar de proyecto o de copia del paquete no cambia la ruta de datos.

El almacén usa transacciones duraderas, revisiones CAS y una cola global por
proceso. Una operación mantiene propiedad exclusiva hasta terminar su callback;
la cancelación no libera esa propiedad mientras el callback siga activo. Otro
proceso recibe un diagnóstico de ocupado, sin robar/borrar locks. Sólo se admite
el hilo principal de Node, en un único host/disco local; se rechazan sistemas
de archivos remotos conocidos (NFS/SMB/CIFS/AFS/Coda/Ceph). No es coordinación
distribuida ni una garantía de `exactly once` remoto.

La instalación/retirada adquiere la misma exclusión **antes de revisar el plan y
durante la aceptación**, además de su bloqueo propio. Actividad, resultados
inciertos, parciales o estado incompatible/corrupto impiden cambiar componentes.
No se recrea una base inválida. El formato de base/planes está versionado y se
declara en `package.json`; no hay migración automática ni downgrade de datos.
La retirada conserva base, staging, recibos y copias del paquete. `check` verifica
el motor en memoria y la instalación, **no reconcilia ni consulta pendientes**.

Para actualizar, ejecutar `install --global --source /ruta/nueva-version.tgz`
con el CLI disponible. Se admite una versión de paquete distinta si mantiene los
formatos de base/plan y las dependencias compatibles. Antes de cambiar JSONC se
validan también los módulos y el motor de la copia candidata. No se convierte
ningún dato: un formato incompatible, incluido un downgrade incompatible, se
bloquea conservando bytes y copia anterior. Un cambio futuro de formato necesitará
una migración explícita, con respaldo y recuperación propios; no está habilitada.

Si una instalación se interrumpe, repetir `install` con el mismo origen. Si se
interrumpe una retirada, repetir `uninstall`: su journal `removing` permite
reanudar incluso después de exportar las cuentas o retirar la referencia.
Mientras tanto `check` devuelve inconsistencia; no se instala sobre una retirada
incompleta. Una exportación ajena o diferente nunca se sobrescribe. La publicación
de configuración/manifiesto sincroniza el archivo y su directorio en disco local.
No borrar locks, `runtime/` ni copias para forzar una actualización.

Política de conservación aprobada para fase 2:

- Resultados terminados: 7 días; propuestas nunca enviadas: 24 horas desde su
  caducidad. La limpieza normal se ejecuta al preparar, no al consultar un recibo.
- Si falta espacio, se pueden retirar antes los terminados y los caducados
  nunca enviados, mezclados por antigüedad (fin/caducidad, respectivamente).
- Nunca se purgan automáticamente operaciones activas, parciales o inciertas ni
  el staging necesario para recuperarlas, aunque haya expirado la autorización.
- Base: 256 MiB, con 16 MiB reservados para progreso; staging: 512 MiB globales.
  SQLite reutiliza páginas liberadas; no se borra/recrea la base para reducirla.
  Si no basta la limpieza elegible, se rechaza la nueva preparación.
  La reserva es margen lógico de admisión, no espacio garantizado por el sistema
  de archivos; los journals transitorios requieren espacio adicional. Un ENOSPC
  real sigue tratándose como fallo de persistencia, no como permiso para reenviar.
- La eliminación de staging usa referencias propias, tamaño y SHA-256, con un
  journal de limpieza recuperable. No borra descargas ni archivos ajenos; material
  alterado o huérfano sin asociación fiable se conserva y cuenta para la cuota.

Cargas protegidas de fase 2:

- Lectura de orígenes Linux mediante descriptores y `O_NOFOLLOW`, sólo bajo
  `uploadRoots` dentro de la ubicación. El llamante debe aportar ubicación
  validada, rutas de credenciales excluidas, permiso `read` y revalidación de
  contexto; cada permiso precede a la apertura. No se amplían raíces mediante
  `external_directory`.
- Se rechazan symlinks, hardlinks, archivos especiales, ejecutables, archivos
  escribibles por grupo/otros, ancestros no confiables y nombres/rutas sensibles.
  La política conservadora de este módulo interno aún no es un esquema público.
- Copia en bloques de 64 KiB, con límites individuales/acumulados/número/tiempo,
  SHA-256 y sincronización de archivo/directorio antes de devolver referencias.
  Cambiar el original después no cambia los bytes fijados; el almacén vuelve a
  verificar el staging al preparar y antes de marcar un paso como enviado.
- Reserva global antes de copiar y comprobación de espacio disponible antes de
  cada escritura. Las reservas se contabilizan completas hasta terminar, además
  de los bytes parciales existentes: la admisión concurrente es conservadora.
  No es preasignación física ni garantiza espacio frente a otros procesos.
- Cancelación/fallo retira sólo los inodes creados por esa copia y libera la
  reserva; el cierre/mantenimiento se bloquea mientras ésta está activa. El
  llamante debe esperar la operación dentro del callback coordinado. Una caída
  puede dejar staging sin plan: se conserva y cuenta para cuota, no se adopta ni
  elimina por su nombre. La asociación duradera se realiza mediante `prepare`.

**Estado de entrega:** todos los tipos conectan al motor protegido y al catálogo
de quince, con pruebas automatizadas de contrato/LAB y entrega independiente del
checkout. No equivale al cierre de la campaña REAL ni modifica por sí misma la
instalación activa o sus permisos.
Cargar el plugin con base vacía sigue sin abrir el almacén ni usar red.

### Revisión y procedimiento del operador

El núcleo interno ya integra preparación sin mutación, contexto de sesión,
huella de política, identidad efímera ligada a la credencial, revisión completa,
permiso y revalidación antes de cada envío, journal/recibos y comprobación directa.
Las mutaciones JSON y multipart tienen destinos tipados, intento único y cero
redirecciones/reintentos, también ante 429/5xx. El multipart sólo lee el descriptor
de staging verificado, con streaming/hash y cabecera anti-XSRF. No hay canal HTTP
genérico para el modelo ni herramienta de carga directa.

El cliente web OpenCode 2.3.0 **no muestra la metadata completa del permiso**.
El spike de servidor abrió SQLite desde su proceso real de plugins (Node
26.3.0); es una comprobación adicional de carga/esquema, no una matriz completa
de regresión Node 26. OpenCode aporta sus módulos de host `@opencode/plugin` y
`effect`: no se fuerzan rutas absolutas a otra copia de esos módulos.
La vista inicial de revisión es un HTML privado estático, sin scripts,
enlaces activos ni red, ligado a propuesta/hash. Máximo 256 KiB de revisión:
excederlo bloquea, nunca trunca. Para propuestas preparadas:

```bash
issuekeeper-jira review --global --proposal ID
issuekeeper-jira status --global --proposal ID
issuekeeper-jira verify --global --proposal ID
```

`status --global` también funciona **sin** `--proposal`: imprime un resumen JSON
global del almacén (recuento por estado, inciertos, parciales y fecha del
pendiente más antiguo) en modo sólo lectura, sin abrir la base para escritura ni
purgar. No incluye claves de ticket, rutas ni contenido. Con `--proposal` el
comportamiento no cambia.

`review` exige terminal local: el usuario abre la ruta impresa en el navegador y copia
el hash de la vista que figura al final. No acepta `--yes` ni tuberías. Registra
acceso/revisión del documento exacto, **no autorización de envío**; la aplicación
requiere además `jira.write` del recurso exacto
`alias/issue/KEY/change/tipo/audiencia/hash`. `save` usa sólo ese recurso. La
revisión se exige también bajo `allow`; éste no se anuncia como decisión humana
nueva. El HTML temporal propio se retira al terminar; una caída puede dejar un
huérfano privado que cuenta para cuota.

`status` no transmite. `verify`, también desde terminal local, sólo comprueba por
lecturas los recibos ya confirmados y puede completar su verificación aunque haya
caducado la autorización. No aplica desde otra sesión, reenvía, restaura a
`prepared` ni resuelve por conjetura un paso incierto sin recibo. Esos pasos se
conservan bloqueados. La continuidad multifase se detiene si no puede acreditarse
frescura; no se atribuyen automáticamente al propio plan todos los cambios de
`updated`. Sólo un remanente `pending`, con anteriores confirmados/verificados,
puede continuar con `jira_change_apply`, dentro del TTL y tras nueva evaluación
de permiso. Los pasos `unknown`, `sending` recuperados o rechazados no se repiten.
Entre archivos Platform se exige historial completo desde la fecha base que
atribuya únicamente los adjuntos del paso a la identidad aprobada; historial
insuficiente o una automatización ajena detiene la continuidad. No es CAS Jira.
Los temporales JSM no se reutilizan pasados diez minutos ni con otra identidad.
Verificar bytes remotos exige permiso `jira.download` separado; el CLI solicita
aceptación explícita. Los bytes se procesan sólo para SHA-256, sin guardarlos.

La fecha real `expectedUpdated` sigue siendo obligatoria incluso con
`changes.requireExpectedUpdated: false`. Las credenciales no se persisten ni se
incluyen en hashes del plan; rotación entre validación/envío bloquea el envío.
Una credencial nueva de la misma identidad puede validarse de nuevo. No se
promete inspección universal de scopes. El parser Markdown fijado utiliza
mdast/micromark con tablas, posiciones UTF-16 originales y límites; no ejecuta
HTML/código ni resuelve recursos. `FORMAT_INVALID`/`FORMAT_NOT_SUPPORTED` no
habilitan degradación silenciosa.

El subconjunto admite párrafos/saltos, negrita/cursiva, encabezados, listas
anidadas, enlaces HTTP/HTTPS, código, citas y tablas con cabecera. Los saltos
ordinarios se conservan; un salto explícito JSM no añade además un LF. Se bloquean
HTML/imágenes, alineación personalizada de tablas, menciones en código/destinos
de enlace o en una etiqueta enlazada que perdería su enlace, y combinaciones
JSM sin equivalencia (p. ej. lista que empieza por un número distinto de uno,
varios bloques por elemento o delimitadores de cierre dentro de código).
Las menciones JSM se comprueban además como identidades ADF por la API Platform;
si la credencial no puede aportar esa prueba, se conserva pendiente de verificar.
En publicación JSM se valida el comentario aprobado y el sufijo de adjuntos
generado por Jira, guardando su hash en el recibo, no reescribiendo el plan.
Mover tickets de proyecto no forma parte de la edición de atributos.

El usuario del servidor es responsable de revisar un pendiente antes del
mantenimiento y de conservar sus componentes/evidencias. Procedimiento:

1. Consultar `status --global --proposal ID` usando el ID devuelto al preparar;
   muestra hash, estados y recibos sin cuerpos ni bytes. No confundirlo con `check`.
2. Para recibos confirmados sin comprobar, ejecutar `verify` desde terminal local
   con la cuenta/identidad original disponible. Puede pedir permiso separado de
   descarga. Una lectura fallida no autoriza a repetir la escritura.
3. Si queda un paso incierto sin recibo, conservar plan, staging y copia del
   paquete; investigar la evidencia remota con el responsable de Jira. No hay
   comando de reset, compensación o resolución por coincidencia de texto.
4. Sólo un remanente `pending` acreditado puede continuar mediante apply dentro
   de la misma sesión/ubicación, vigencia y política. Si ya no es posible,
   mantenerlo bloqueado; ni reinstalar ni preparar un duplicado lo resuelven.

Los inciertos/parciales se conservan sin plazo automático de borrado y bloquean
actualización/retirada. Su responsable debe revisarlos antes de volver a intentar
el mantenimiento y al diagnosticar presión de cuota; no se renueva el TTL.

### Matriz de representación implementada

Contrato comprobado por regresión y matriz funcional REAL del laboratorio M5;
las evidencias privadas distinguen verificaciones API y observaciones humanas.
Las dos columnas JSM cubren también `additionalComment.body` al publicar adjuntos.
La audiencia nunca cambia para conseguir compatibilidad.

| Elemento | Platform (ADF) | JSM interno / público (string wiki) |
| --- | --- | --- |
| Plain y símbolos literales | Texto literal | Escape de sintaxis wiki |
| Párrafos y saltos LF/CRLF | Bloques / hardBreak | Saltos conservados sin duplicación |
| Negrita, cursiva y encabezados | Nodos / marcas ADF | Sintaxis wiki equivalente |
| Listas y anidación | Listas estructuradas | Subconjunto equivalente; sin inicio distinto de 1 ni varios bloques por elemento |
| Enlaces | Sólo HTTP/HTTPS | Sólo HTTP/HTTPS |
| Código inline y bloques | Literal, sin menciones | Literal; se rechazan delimitadores de cierre incompatibles |
| Citas y tablas con cabecera | Estructura ADF | Cita / tabla wiki; sin alineación personalizada |
| Menciones explícitas | Identidad ADF revalidada | Identidad wiki revalidada y comprobación posterior de identidad ADF |
| HTML, imágenes y elementos sin equivalencia | Rechazo, sin ejecutar recursos | Rechazo, sin degradación silenciosa |

Ante `FORMAT_INVALID`/`FORMAT_NOT_SUPPORTED`, aceptar una alternativa significa
preparar **otro plan**, con hash y revisión nuevos; nunca convertir al aplicar.

Regresión funcional offline: `npm run test:phase2:functional`; la suite completa
`npm run test:mock` conserva también las pruebas de lectura, estado e instalador.

Alternativa manual: integrar [opencode.example.jsonc](./opencode.example.jsonc)
sin reemplazar la configuración existente y registrar
[templates/jira.md](./templates/jira.md).

### Comandos de conveniencia

El tarball incluye [jira-get](./templates/commands/jira-get.md),
[jira-list](./templates/commands/jira-list.md) y
[jira-update](./templates/commands/jira-update.md). Copiar los que se deseen a
`.opencode/commands/` del proyecto o a `$XDG_CONFIG_HOME/opencode/commands/`
(por defecto `~/.config/opencode/commands/`), sin sobrescribir personalizaciones.
No se registran automáticamente ni el instalador se apropia de comandos ajenos.

`/jira-update En trabajo, añade la etiqueta analizado a IK-123` sólo consulta y
prepara; no invoca apply ni constituye aprobación. Para una carga, indicar
archivos dentro de `uploadRoots`, audiencia y comentario JSM opcional. Los IDs y
la fecha salen de consultas, no de ejemplos. Después, revisar en la terminal con
el comando exacto devuelto y pedir la aplicación en la misma sesión. Ante un
resultado parcial/incierto, seguir el [procedimiento del operador](#revisión-y-procedimiento-del-operador).

## Cuentas y secretos

`accounts: []` es válido y registra las quince herramientas sin red ni permisos.
`jira_accounts_list` devuelve `[]` con indicaciones; las demás herramientas
con cuenta explícita devuelven `ACCOUNT_UNAVAILABLE` antes de acceder a Jira o
pedir permisos remotos; apply sólo acepta un `proposalId` local válido.

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
| `jira_issue_edit_metadata` | `account`, `issueKey` |
| `jira_transitions_list` | `account`, `issueKey` |
| `jira_issue_update_prepare` | `account`, `issueKey`, `expectedUpdated`, `fields?`, `update?` (al menos uno) |
| `jira_comment_prepare` | `account`, `issueKey`, `expectedUpdated`, `text`, `audience`, `format?`, `mentions?`, `visibility?` |
| `jira_attachment_upload_prepare` | `account`, `issueKey`, `expectedUpdated`, `audience`, `files`, `comment?`, `format?`, `mentions?` |
| `jira_transition_prepare` | `account`, `issueKey`, `expectedUpdated`, `transitionId`, `fields?` |
| `jira_change_apply` | Sólo `proposalId` |

Los argumentos son estrictos. No admiten ubicaciones, URLs, cabeceras ni métodos.
Todas las herramientas verifican la sesión y su ubicación canónica desde el
servidor antes de permisos/red. Los rechazos y cancelaciones de OpenCode se
propagan nativamente; los errores de aplicación incluyen `warnings`, `fieldErrors`
cuando proceda, y `meta`. `TIMEOUT` sólo corresponde al temporizador interno.
Una línea JSON en stderr correlaciona `requestId`, herramienta, alias, operación,
último estado HTTP, intentos y duración. No registra cuerpos, cabeceras ni URLs.

### Métricas del proceso

Al liberar el plugin se escribe una línea JSON en stderr con el mismo formato de
diagnóstico: `{"event":"issuekeeper.metrics","metrics":{...}}`. Sólo contiene
contadores de baja cardinalidad: peticiones, 429, 5xx, errores, suma/máximo de
latencia por alias y tipo (`read`/`write`/`binary`), y propuestas preparadas,
aplicadas, rechazadas, en conflicto o inciertas por alias. Nunca incluye texto
de tickets, claves, hashes, rutas ni identificadores de petición.

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

Comentarios JSM: audiencia internal/public por comentario. La lectura histórica
de texto no acredita una identidad de mención; conserva su advertencia. La
verificación de una publicación nueva exige la prueba adicional descrita arriba.
Adjuntos JSM: `unknown` si la API no declara audiencia.

Los candidatos usan búsqueda contextual, nunca un directorio global; público
recorre informador, Platform y participantes en páginas por origen. Se mantienen
homónimos e identidades, no emails. `query`: 2–100 caracteres; `accountId` excluyente.
`visibility: {type: "role"|"group", value}` sólo para ticket. Interno o visibilidad
restringida se marca `unverified`; `validated` sólo acredita el origen contextual,
**no autoriza una publicación**. Una identidad puede repetirse entre páginas de
orígenes distintos: deduplicar por `accountId`. Un vacío no prueba inexistencia.

### Permisos y descargas

Las fichas de las herramientas paginadas publican el máximo efectivo de
`output.maxPageSize`; si no se solicita un tamaño concreto, puede omitirse
`maxResults` para utilizar el predeterminado de la instalación.

| Acción | Recurso |
| --- | --- |
| `jira.accounts` | `*` |
| `jira.read` | `alias/connection`, `alias/search`, `alias/issue/KEY` |
| `jira.read` (candidatos) | `alias/issue/KEY/mentions/audience`, además de la lectura del ticket |
| `jira.download` | `alias/issue/KEY/attachment/ID/ruta-relativa` |
| `edit` | destino y temporal relativos; `save` sólo contiene el destino |
| `jira.write` | `alias/issue/KEY/change/tipo/audiencia/hash`, también en `save`, sin comodines |
| `read` | Archivo de origen de carga, antes de abrirlo; sólo dentro de `uploadRoots` |

También se autoriza la clave canónica si difiere. La sesión se vuelve a validar
tras la aprobación de descarga. Nunca se permiten raíces externas, por lo que no
es necesaria una aprobación `external_directory`.

Se verifica pertenencia por listado y metadata Platform antes del contenido.
Linux `/proc/self/fd`, recorrido con descriptores/O_NOFOLLOW, directorios privados,
temporal exclusivo 0600, streaming con tamaño/SHA-256, publicación sin sobrescribir
y limpieza sólo del temporal propio. El recibo incluye sitio, vía, nombre remoto,
MIME, audiencia y ruta relativa del servidor. No abre ni entrega bytes al modelo.
`downloadDir` y `uploadRoots` deben estar dentro de la ubicación, fuera de secretos.

Platform pide `redirect=false` y la transferencia acepta cualquier MIME binario.
JSON rechaza todo 3xx. Una descarga admite un único salto HTTPS al origen exacto
`https://api.media.atlassian.com`, ruta `/file/<uuid>/binary`, sin usuario,
contraseña, puerto alternativo ni fragmento. Se omiten credenciales y cookies
en medios; otro salto se rechaza con `REDIRECT_NOT_ALLOWED`. Nunca se muestra
la URL firmada. La compatibilidad funcional de cada sitio se valida aparte.

## Límites y decisiones

Predeterminados compartidos en `src/defaults.ts`: 20 s HTTP, 3 intentos, 1 MiB JSON,
3 concurrentes por alias y un tope compartido de **3 por sitio** (ambos toman
`maxConcurrentPerAccount`); el backoff libera ambos permisos. Salida 25/100 y
12000 caracteres; adjuntos 20 MiB, 120 s, `overwrite: false` como único valor.
Binarios sin reintentos. Las opciones no anulan `readOnly`, revisión íntegra,
restricciones ni permisos nativos. `remoteWrites` por cuenta sólo anuncia
disponibilidad local configurada: no garantiza permisos Jira.

Decisiones D-01…D-16: JQL único; destino de medios explícito y acotado; concurrencia alias+sitio;
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
npm run test:phase2:storage
npm run test:phase2:files
npm run test:phase2:engine
npm run test:phase2:functional
npm run test:phase2:delivery
npm run test:phase2:campaign
npm run test:checkout
npm run build
node scripts/versions.mjs
```

Informes separados en `reports/mock/` y `reports/live-read/`, excluidos de Git y del
tarball. CI declara Node 22/24, vigencia del esquema, artefactos y job aislado del
instalador. La matriz declarada no es evidencia de su ejecución.
`npm test` sólo selecciona unitarias/contrato/instalador offline, incluso si hay
variables live en el entorno. En checkout sin el documento local excluido de Git,
sólo las comprobaciones opcionales contra esa especificación se omiten y se
reportan como tales; defaults, esquemas, plantillas y comandos versionados se
comprueban siempre. El smoke prepara desde una copia instalada, actualiza a un
tarball de versión sintética compatible, aplica con journal/permisos
instrumentados, deduplica y comprueba recibos después de retirar, sin Jira real.

Para integración real, preparar fuera del repositorio opciones e inventario con
el contrato de `test/integration/inventory-read.test.ts`, dos sitios y ambas
modalidades de token:

```bash
ISSUEKEEPER_LIVE_READS=1 \
ISSUEKEEPER_LIVE_DOWNLOADS=1 \
ISSUEKEEPER_LIVE_CONFIG=/ruta/privada/options.json \
ISSUEKEEPER_LIVE_INVENTORY=/ruta/privada/inventory.json npm run test:live:read
```

Permisos instrumentados del SDK, no una demostración de su política en servidor.
El workflow manual requiere configurar y proteger el entorno `jira-integration`
y sus secretos; nunca se activa desde pull requests ni forks.
`test:live` es un alias de sólo lectura por compatibilidad. No selecciona suites
futuras de escritura. La campaña de escritura de M5 queda exclusivamente local y
autorizada por separado: no hay selector, credencial de escritura ni subida de
informes privados de esa campaña en CI. Omitida no significa superada.

El controlador local `scripts/phase2-campaign.mjs` recibe un paquete **instalado**,
una configuración JSONC con un único plugin Jira y un manifiesto privado versionado
(`version: 1`, `targets`, `scenarios`, `maxMutations`, `retentionReview`). Cada destino
declara `account`, `site`, `issueKey` y, para temporales JSM, `serviceDeskId`. Cada
escenario declara `id`, destino, `kind` (`metadata`, `fields`, `transition`, `comment`
o `upload`) e `input` sin cuenta, clave, fecha ni propuesta: la fecha siempre procede
de la metadata real. Las cargas usan `fixtures` ficticios (`name`, `kind`:
`empty`/`binary`/`text`), nunca archivos de credenciales.

```bash
XDG_DATA_HOME=/ruta/privada/campaña-nueva/data \
node scripts/phase2-campaign.mjs /ruta/paquete-instalado \
  /ruta/config-qa.jsonc /ruta/manifiesto-qa.json \
  /ruta/privada/campaña-nueva --qa-authorized
```

El directorio de salida debe ser nuevo y contener el runtime aislado. No cambia la
configuración original: habilita sólo las cuentas QA seleccionadas en memoria.
Exige lista cerrada de destinos y presupuesto; comprueba `sending` duradero y
recurso/hash exactos antes del transporte. Guarda revisiones, planes/recibos y
ledger privado sin cabeceras ni URLs de medios, y se detiene ante un fallo sin
repetir el envío. No se debe relanzar una campaña incierta: recuperar mediante
`status`/`verify`, sin editar estados ni crear propuestas duplicadas.

`scripts/phase2-fixtures.mjs` admite inventario acotado y creación explícita de
tickets/solicitudes QA con prefijo `IK-M5-QA `, manifiesto privado y el mismo opt-in;
no administra proyectos, usuarios ni workflows. Ambos controladores son utilidades
del checkout, no herramientas del modelo ni parte del tarball. Sus permisos SDK son
**instrumentados**, no decisiones humanas. Un resultado automático satisfactorio
no cierra G3/G4 ni sustituye contraste web, dos proveedores y permisos nativos.

En comentarios restringidos, la revisión conserva el nombre y la referencia
resuelta. Para grupos se fija además su ID estable y se revalida antes del envío;
no se acepta que otro grupo sustituya al original bajo el mismo nombre. Jira
recibe sólo `identifier` (o `value` para planes antiguos compatibles), nunca ambos.
El sitio debe permitir la restricción elegida: «Sólo roles de espacio» rechaza
grupos aunque la persona pertenezca a ellos. Ese rechazo no cambia la audiencia
ni provoca un reintento sin restricción.

JSM no utiliza los escapes Markdown para texto literal: el conversor no escapa
puntos ni duplica una barra ordinaria en `\\` (Jira lo interpreta como salto).
Secuencias literales de dos barras o barra seguida de metacarácter sin una
representación fiel comprobada se rechazan con `FORMAT_NOT_SUPPORTED`, sin
preparar una versión alterada; cualquier alternativa requiere nueva propuesta.
Texto vacío o compuesto sólo por espacios se rechaza como `FORMAT_INVALID`.
Mientras espera `jira.write`, el motor comprueba contexto y TTL localmente; un
cambio de ubicación o expiración termina la aplicación sin enviar, libera el
coordinador y no permite que una concesión tardía la reactive.
Los resultados operativos conservan el progreso por paso: `data.error.code`
identifica `PARTIAL_UPLOAD` cuando hay remanente conocido y `WRITE_OUTCOME_UNKNOWN`
cuando falta acreditar un envío o su verificación. Ninguno es reintentable; la
incertidumbre prevalece aunque otros archivos tengan recibos confirmados.

Controlador local sin Jira: `npm run build` y
`node scripts/lab.mjs HT-01`…`HT-08`. Variantes: HT-02 código HTTP;
HT-03 `cancel`; HT-04 `redirect`/`large`; HT-05 `restricted`; HT-06 `redirect`.
Usa identidades ficticias y transporte inyectado; no equivale a observación real.

Controlador ampliado, también sin red ni credenciales reales:
`node scripts/lab-closure.mjs HT-01`…`HT-08`. Admite además `BU-04`, `PE-06`
y `DE-06`…`DE-08`. Registra variantes y comprobaciones observables: espera,
colas, validación de medios, permisos previos, cancelación tras recibir bytes,
cambio de ubicación y almacenamiento simulado. Los errores ENOSPC/EIO se inyectan
solo en descriptores del directorio privado del caso; no se llena el disco.
Cada ejecución tiene presupuesto de 30 segundos y conserva el aislamiento de
las evidencias LOCAL/LAB respecto de Jira real.

El cierre requiere el informe privado de campaña, no solo pruebas automatizadas:
dos proyectos/modelos, políticas reales, ambas identidades JSM, scopes, hashes,
rotación real de token y todas las variantes obligatorias. El laboratorio sintético
no sustituye esas evidencias ni demuestra resistencia exhaustiva a procesos
hostiles del mismo UID. No hay barrido general de temporales huérfanos ni cuota
para descargas (ADJ-04), ni división completa de cloud.ts (ARQ-05); las cuotas de
base/staging de escritura sí se aplican según la política anterior.
El instalador no verifica todos los archivos transitivos contra un inventario de
integridad; conflictos complejos de migración requieren revisión manual.

Excluir `.issuekeeper/` de Git y del contexto en otros proyectos. Los permisos
0700 no aíslan procesos maliciosos del mismo UID: se requiere separación del host.
Dependencias fijadas: SDK 2.2.5, Zod 4.6.7, jsonc-parser 3.3.1. npm audit mantiene
21 avisos moderados transitivos; no se fuerzan actualizaciones incompatibles.
Uso interno, sin publicación ni licencia de distribución elegida.
