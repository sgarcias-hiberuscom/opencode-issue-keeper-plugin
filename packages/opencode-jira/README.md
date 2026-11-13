# IssueKeeper Jira — fase 1

Plugin de **servidor OpenCode V2**, privado y de sólo lectura remota. No registra
preparación/aplicación de cambios, comentarios nuevos, cargas ni transiciones.
La descarga escribe únicamente en el disco del servidor, con permisos explícitos.

## Instalación local

Desde la raíz de IssueKeeper:

```bash
npm --prefix packages/opencode-jira ci
npm --prefix packages/opencode-jira run typecheck
npm --prefix packages/opencode-jira test
npm --prefix packages/opencode-jira run build
npm --prefix packages/opencode-jira run test:pack
```

Incorpora las entradas de [opencode.example.jsonc](./opencode.example.jsonc) a tu
`opencode.jsonc` de la raíz **sin reemplazar configuración existente**. Sustituye
sitio, identidad, proyectos y referencias al secreto. Para uso global, emplea una
ruta absoluta al directorio del paquete. No apuntes directamente a `dist/index.js`
ni dupliques la carga por descubrimiento automático. Este paquete no está publicado.

Guarda y usa `/reload` si es necesario; no hay que reiniciar el servicio por una
configuración normal. Reconstruye `dist` tras editar TypeScript. Los comandos
`/jira-get trabajo IK-123` y `/jira-list trabajo mis tickets abiertos del proyecto IK`
no fijan modelo ni agente; son plantillas, no barreras de seguridad.

### Secretos

- Una fuente por cuenta: `tokenFile` absoluto o **nombre** de `tokenEnv`.
- Nunca pegues el token en el chat, JSON de opciones, resultados o repositorio.
- Archivo regular, sin symlink final, del usuario del servidor y modo `0600` (o más
  restrictivo). Se relee al operar, permitiendo rotación sin recompilar.
- Se admite un salto de línea final; no hay longitud de token fija.
- Las variables tienen que existir en el proceso servidor, no sólo en otra terminal.
- `cloud-token`: sitio directo; `cloud-scoped-token`: `cloudId` UUID obligatorio y
  gateway Atlassian derivado internamente. Ambos usan Basic email:token.
- Una cuenta con secreto ausente no impide registrar herramientas ni usar las demás.
- `connection_test` comprueba `/myself`; no prueba acceso a proyectos o JSM.

Los permisos del host siguen importando: otras herramientas con acceso al archivo
o al entorno podrían leerlo. Este plugin no proporciona un sandbox del servidor.

## Herramientas registradas

| Nombre efectivo | Entrada |
| --- | --- |
| `jira_accounts_list` | `{}` |
| `jira_connection_test` | `account` |
| `jira_issue_get` | `account`, `issueKey`, `fields?` |
| `jira_issues_search` | `account`, `project`, filtros opcionales, `fields?`, `maxResults?`, `cursor?` |
| `jira_comments_list` | `account`, `issueKey`, `audience?`, `maxResults?`, `cursor?` |
| `jira_attachments_list` | `account`, `issueKey`, `maxResults?`, `cursor?` |
| `jira_attachment_download` | `account`, `issueKey`, `attachmentId`, `destinationName?` |

Todos los alias son explícitos. No existe una cuenta activa global ni se prueban
códigos en otros perfiles. Los resultados llevan `ok`, `account` (operaciones de
cuenta), `data`/`error`, advertencias y `meta.requestId`, `truncated`,
`untrustedContent`. Los errores no incluyen cuerpos remotos, secretos o headers.
Los rechazos de permisos de OpenCode se propagan como fallos nativos.

### Búsqueda y campos

```json
{
  "account": "trabajo",
  "project": "IK",
  "assignee": "me",
  "statusCategory": "notDone",
  "updatedSince": "2026-11-01",
  "maxResults": 25
}
```

Se genera JQL acotado y se usa exclusivamente `POST /rest/api/3/search/jql`.
**No se acepta `jql` libre**: se evita un parser incompleto que pudiera eludir
`allowedProjects`. `assignee`: `me`/`unassigned`; `statusCategory`:
`notDone`/`To Do`/`In Progress`/`Done`; `updatedSince`: `YYYY-MM-DD`.
El orden es `updated DESC, key ASC`. Se entrega una página, sin prometer `total`.
Al pasar cursor, repite cuenta, filtros, campos y tamaño. El cursor opaco está
ligado a esa consulta, caduca en diez minutos y se pierde al descargar el plugin.
Hay un límite de 100 páginas por cadena y 1000 cursores en memoria.

`allowedReadFields` permite configurar una allowlist (IDs API, no etiquetas):
campos estándar de la lista siguiente o `customfield_<número>`. No admite campos
embebidos de comentarios, adjuntos o historial que eviten sus operaciones específicas.
Por defecto: `summary`, `description`, `status`, `assignee`, `reporter`, `project`,
`updated`, `labels`, `priority`, `issuetype`. Los campos de estructura/política
`project`, `updated`, `summary`, `status` se solicitan siempre. Los personalizados
sólo se devuelven si figuran en la allowlist y selección efectiva. No se pide
historial ni correos/avatares de usuarios por defecto. El contenido de campos
personalizados puede contener datos personales: administra su allowlist.

Se valida el proyecto **real** de cada respuesta, incluidas claves movidas. La vista
ADF conserva separadores básicos y advierte de nodos no soportados; no es una
conversión reversible. El presupuesto de texto se aplica a la salida sin romper
JSON; salidas estructurales excesivas se rechazan, no se cortan como texto JSON.

### JSM: agentes y clientes

Activa `serviceManagement.enabled` por perfil. Se consulta la solicitud real;
en JSM, los comentarios se leen sólo mediante `/rest/servicedeskapi`, con filtros
`public`/`internal` y paginación `start`/`limit`. Cada comentario conserva su audiencia.
No se recurre a Platform si falla el acceso JSM. Un cliente puede recibir una
lista vacía de notas internas: no demuestra que no existan.

Si Platform devuelve 403/404 pero el portal permite leer la solicitud, se comprueba
el proyecto mediante `expand=serviceDesk` (ID/proyecto reales). Se devuelve
`source: "jsm-request"`, sin inventar `updated` o ID de estado. Si esa expansión no
está disponible, se falla de forma segura. La búsqueda sigue requiriendo acceso
Jira Platform; tener acceso al portal no implica poder ejecutar JQL ni `/myself`.

Un perfil habilitado para JSM que no pueda confirmar la solicitud **no** lista
comentarios/adjuntos vía Platform como alternativa. Para tickets ordinarios usa
un perfil Platform explícito (`serviceManagement.enabled: false`). En el listado
JSM de adjuntos, la API no declara audiencia: se devuelve `unknown`, no una
deducción por nombre o identidad. Los enlaces recibidos nunca se siguen; sólo se
extrae el ID de metadata validada.

### Descarga segura

- Se lista y verifica pertenencia cuenta/ticket antes de descargar el ID.
- Requiere `jira.read`, `jira.download` y `edit` para directorios, temporal y destino.
  Las rutas se fijan dentro de la ubicación del plugin; no se permiten destinos
  externos ni parámetros que amplíen raíces. Si la sesión cambia de ubicación
  durante la autorización, se rechaza la transferencia.
- **Linux con `/proc/self/fd`**: apertura de la jerarquía con descriptores y
  `O_NOFOLLOW`, directorios privados `0700`, temporal exclusivo `0600`, publicación
  por hard link sin sobrescritura, tamaño y SHA-256 durante streaming.
- No acepta symlinks en la jerarquía. Un directorio de descarga preexistente y sus
  padres bajo la ubicación deben ser del usuario y privados. No cambia sus modos
  automáticamente ni borra archivos existentes. Usa un filesystem que admita hard links.
  La ubicación debe pertenecer al usuario, sin escritura de grupo/otros; los
  ancestros deben pertenecer al usuario o root. El despliegue debe impedir que
  usuarios no confiables renombren esa jerarquía desde directorios superiores compartidos.
- `downloadDir` predetermina `.issuekeeper/downloads`, siempre dentro de la ubicación
  del servidor y fuera de secretos/metadatos. La ruta del recibo es relativa a ella.
  Los nombres remotos se sanean; un nombre explícito no puede ser una ruta.
- Máximo por fichero 20 MiB y timeout 120 s por defecto, también con límite real
  del stream. Tamaño distinto de la metadata implica fallo y limpieza del temporal.
- Platform usa `redirect=false`. **Todas las redirecciones se rechazan**, también
  las 303 de JSM: no hay aún allowlist administrada de medios. Si el tenant exige
  un enlace firmado, la descarga devuelve un error seguro, sin cambiar de API,
  reenviar credenciales o devolver esa URL al modelo.
- No se abre, ejecuta, descomprime ni añade el contenido al modelo. Las descargas
  completadas permanecen en el servidor; su eliminación es una acción separada.

`.issuekeeper/` está excluido de Git en este repositorio. En otros proyectos,
exclúyelo igualmente de Git y de mecanismos de incorporación automática al contexto.
El aislamiento frente a procesos maliciosos del mismo UID exige separación del host;
los permisos `0700` no sustituyen ese aislamiento.

## Configuración y límites

[options.schema.json](./options.schema.json) se genera desde los validadores con
`npm run build`. El parser runtime es la autoridad, incluidas restricciones entre
campos que JSON Schema no representa. Rechaza claves desconocidas, alias repetidos,
cuenta predeterminada inexistente, orígenes no Cloud/HTTPS, fuentes ambiguas y
límites no acotados. No se hacen llamadas Jira dentro de transforms.

| Grupo | Valores predeterminados |
| --- | --- |
| Cuenta | `readOnly: true`, JSM deshabilitado, `allowedUpdateFields: []` |
| HTTP | 20 s total incluida cola/backoff; 3 intentos; 1 MiB JSON; 3 concurrentes por sitio |
| Salida | 25 elementos, máximo 100, 12000 caracteres de texto |
| Adjuntos | habilitados, 20 MiB por fichero, timeout 120 s, sin sobrescritura |

Se comparten colas entre perfiles del mismo sitio. Sólo lecturas transitorias se
reintentan con backoff y `Retry-After`; no se reintentan 400/401/403/404 ni descargas
binarias. La cancelación y descarga del plugin abortan trabajo pendiente.
Las opciones `changes` y de carga se validan para aceptar la configuración de la
guía, pero **no activan escritura ni staging**. No hay auditoría persistente de
propuestas ni recibos de escritura en esta fase; se devuelve correlación por petición.

## Pruebas

La campaña manual desde cero está descrita en el [plan de pruebas de fase 1](../../doc/plan-pruebas-manuales-fase-1.md): alta de Jira/JSM, identidades, fixtures, instalación y casos con evidencias y criterios de aceptación.

`npm test` usa transporte simulado, dos perfiles y escenarios agente/cliente. No
contacta Jira ni modifica el servicio OpenCode. Incluye contratos de permisos V2,
cursores, URLs, secretos/rotación, ADF, respuestas inválidas, límites, redirecciones,
cancelación, concurrencia, pertenencia, symlinks, descargas parciales y no sobrescritura.
El workflow CI declara Node 22 y 24; que exista la matriz no afirma que ya haya corrido.
`npm run test:pack` instala el tarball en un directorio temporal aislado y prueba
su export y registro V2 sin conectar a Jira; elimina sólo ese directorio al terminar.

La integración real está **omitida por defecto**. Para ejecutarla, prepara una
solicitud de pruebas accesible por dos identidades (agente/cliente), con comentario
y adjunto internos y otros públicos ya existentes. El test sólo los lee:

```bash
export ISSUEKEEPER_LIVE_READS=1
export ISSUEKEEPER_LIVE_CONFIG=/ruta/privada/options.json
export ISSUEKEEPER_LIVE_FIXTURE='{"agent":"trabajo","customer":"cliente","issueKey":"IK-123","internalCommentId":"1001","internalAttachmentId":"1002","publicCommentId":"1003","publicAttachmentId":"1004"}'
npm test -- test/integration/live-read.test.ts
```

`options.json` contiene sólo las opciones del plugin y referencias a secretos, no
el objeto OpenCode completo; no se versiona. Se exige llegar al final del listado
(máximo 20 páginas) y comprobar los IDs conocidos, no sólo que una lista sea vacía.
No habilites estas variables en CI de PRs no confiables.

Antes de considerar validada una instalación: probar carga real y `/reload`, dos
cuentas, rechazo de lectura/descarga, una descarga y su hash, y consultas con dos
modelos con tool calling. Esas pruebas requieren entorno y autorización del usuario;
los mocks no las sustituyen.

## Compatibilidad y seguridad de dependencias

Base comprobable: SDK fijado `@opencode/plugin@2.2.5`, TypeScript `5.9.3`, Zod
`4.6.7`, Vitest `4.1.12`, Node 22 (desarrollo local: 22.23.2). Se comprueba el contrato
`Plugin.define`, registro `ctx.tool.transform` y permisos contra esos tipos.
No se declara compatibilidad con cualquier versión V2 ni se fija proveedor de IA.

La auditoría npm mantiene avisos **moderados** transitivos del SDK (`glob`,
`minimatch` y dependientes), sin corrección compatible ofrecida por npm. No se
fuerzan overrides mayores sin validar el SDK. Revisar `npm audit` antes de desplegar;
no se afirma una cadena de suministro libre de vulnerabilidades.

Uso interno/personal; `private: true` evita publicación accidental. No se ha
elegido licencia de distribución. La recogida de API tokens para apps cloud de
terceros requiere revisar las condiciones Atlassian y una arquitectura OAuth/Forge.
