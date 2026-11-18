# Matriz de compatibilidad

Combinaciones soportadas por `@issuekeeper/opencode-jira` y su estado de comprobación. Una celda
**Comprobado (fecha)** indica evidencia registrada de la validación; **Declarado, sin prueba** indica que la
combinación se declara soportada pero su evidencia se registra al completar la campaña de validación (T17–T19);
**✘** indica expresamente no soportado.

## Sistema operativo y almacenamiento

| Combinación | Soportado | Estado |
| --- | --- | --- |
| Linux x64, disco local | ✔ | Comprobado (2026-11-18): suite completa e instalaciones verificadas en host Linux x64 y contenedores. |
| Windows, macOS | ✘ | No soportado. |
| Almacenamiento en red (NFS) | ✘ | No soportado: el almacén SQLite exige bloqueos locales de inode. |

## Runtime del CLI e instalador (Node)

| Versión | Soportado | Estado |
| --- | --- | --- |
| Node 22 | ✔ | Comprobado (2026-11-18): suite completa y recorridos de instalación en Node 22.23.2/22.23.5. |
| Node 24 | ✔ | Comprobado (2026-11-18): recorrido de instalación desde registro en Node 24.22.3 y regresión de entrega. |
| Node 26 (runtime de plugins de OpenCode) | ✔ | Comprobado (2026-11-18): instalación y carga del plugin con Node 26.13.1 en contenedor; la sesión real del usuario se verifica en la campaña de compatibilidad (T19). |

## OpenCode y SDK

| Componente | Soportado | Estado |
| --- | --- | --- |
| OpenCode 2.3.x (proceso de plugins) | ✔ | Declarado, sin prueba: se observaron 2.3.0 y 2.3.2 y la carga se verificó en contenedor con Node 26; la comprobación en sesión real del hogar del usuario queda para T19. |
| SDK `@opencode/plugin` 2.2.5 | ✔ | Comprobado (2026-11-18): contrato de plugins ejercitado por las pruebas de contrato y por la carga de la copia activa (15 herramientas registradas). |
| Code Mode | ✔ | Declarado, sin prueba: se comprueba con los proveedores de modelos en T19. |

## Plataforma de tickets y autenticación

| Combinación | Soportado | Estado |
| --- | --- | --- |
| Jira Cloud Platform | ✔ | Declarado, sin prueba: la evidencia de lectura/escritura se registra en T17–T19. |
| Jira Service Management (comentarios, cargas, visibilidad) | ✔ | Declarado, sin prueba: la evidencia se registra en T17–T19. |
| Jira Data Center / Server | ✘ | No soportado. |
| Autenticación `cloud-token` | ✔ | Declarado, sin prueba: se comprueba en T17–T19. |
| Autenticación `cloud-scoped-token` | ✔ | Declarado, sin prueba: se comprueba en T17–T19. |
| OAuth | ✘ | No soportado. |

## Modelos y proveedores (con tool calling)

| Combinación | Soportado | Estado |
| --- | --- | --- |
| GitHub Copilot — Haiku 5.5 | ✔ | Declarado, sin prueba: comprobación con sesión real en T19. |
| OpenRouter — Nemotron 3.5 Super VL free | ✔ | Declarado, sin prueba: comprobación con sesión real en T19. |
| Otros proveedores con tool calling | ✔ (condicionado) | Declarado, sin prueba: no se descartan, pero sólo se declaran comprobados los listados. |

## Limitaciones conocidas

- La coincidencia de claves entre sitios distintos sólo está verificada en simulación; con sitios reales puede
  requerir revisión del operador antes de aceptar una propuesta.
- Jira rechaza con HTTP 400 un archivo temporal vacío en JSM (Platform sí lo acepta y verifica); no existe
  alternativa automática de audiencia o endpoint ante ese rechazo.
- Un cliente exclusivo de portal de JSM no obtiene la frescura de Platform: el producto no inventa valores `updated`
  ni declara escrituras para ese caso; sólo lectura, ocultación y descarga pública como cliente están contrastadas.
- Código, HTML, imágenes y secuencias wiki sin representación no se degradan silenciosamente: producen diagnóstico y,
  si procede, exigen una alternativa expresamente aceptada y un plan nuevo.
- Las narraciones de los modelos son observaciones puntuales, no garantías: las defensas del servidor y la revisión
  humana en terminal son lo que valida cada operación.
