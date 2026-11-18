# Política de seguridad

## Cómo informar de una vulnerabilidad

- Canal de informe: **PENDIENTE** — el canal definitivo (correo o formulario de Hiberus) será
  indicado por el usuario o el departamento legal; sustituya este marcador antes de la
  distribución de la versión final.
- Incluya: versión afectada (`1.0.0-rc.1` o posterior), componente (instalador, CLI, plugin,
  herramientas), pasos de reproducción e impacto estimado. No incluya tokens, cuerpos de
  tickets ni datos personales en el informe.
- No abra incidencias públicas del repositorio para vulnerabilidades: use sólo el canal de
  informe y comparta la evidencia por una vía privada.

## Datos que no se registran

El plugin y su instalador no registran ni propagan: tokens, cabeceras de autenticación,
perfiles de cuenta completos (más allá de lo necesario para operar), cuerpos de tickets,
contenido de comentarios o adjuntos, rutas personales ni datos de proyectos en las etiquetas
de métricas (sólo etiquetas de baja cardinalidad). Las credenciales viven en el archivo
referenciado por el perfil de cuenta o en la variable de entorno configurada; nunca en la
configuración registrada, el manifiesto del instalador, el chat ni los logs.

## Rotación de tokens

Resumen del procedimiento (detalles en la guía, sección 11.3):

1. Cree el token nuevo con permisos mínimos y expiración apropiada.
2. Sustituya el secreto de forma segura y atómica, protegiendo el material de recuperación
   durante la validación; no lo copie al chat, a logs ni al manifiesto del instalador.
3. Compruebe una lectura autenticada y confirme sitio e identidad; verifique el alcance
   efectivo para las operaciones previstas (una lectura correcta no acredita la escritura).
4. Invalide las propuestas no ejecutadas si cambió la identidad o el alcance; para
   ejecuciones en curso, parciales o inciertas, conserve plan y progreso y revíselas antes
   de continuar.
5. En rotación ordinaria, revoque el token anterior sólo tras validar la sustitución y el
   tratamiento de las pendientes; elimine de forma segura las copias temporales.

Ante un secreto comprometido, priorice su revocación inmediata y la contención de las
operaciones afectadas; el procedimiento ordinario no justifica mantenerlo activo.

## Alcance soportado

| Componente | Soportado |
| --- | --- |
| Sistema operativo y almacenamiento | Linux x64, disco local |
| Runtime del CLI e instalador | Node 22 y Node 24 |
| Proceso de plugins de OpenCode | OpenCode 2.3.x con su Node embebido (26.x) |
| SDK de plugins | 2.2.5 |
| Plataforma de tickets | Jira Cloud Platform y Jira Service Management |
| Autenticación | `cloud-token` y `cloud-scoped-token` |
| Modelos | Dos proveedores con tool calling y Code Mode |

Fuera de alcance (no soportado): Windows y macOS, Jira Data Center/Server, almacenamiento en
NFS y publicaciones npm no autorizadas.
