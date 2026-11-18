# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y
versionado según [SemVer](https://semver.org/lang/es/).

## [1.0.0-rc.1]

### Añadido

- Lectura de tickets de Jira Cloud por clave con selección explícita de campos.
- Búsqueda de tickets con JQL y cursor, con campos reducidos y paginación controlada.
- Descarga de adjuntos a un directorio local aislado, con verificación opcional de SHA-256.
- Escritura protegida: preparación de atributos, comentarios y transiciones como propuesta
  revisable por el operador, aplicación atómica con recibos por paso y reconciliación de
  resultados inciertos (`WRITE_OUTCOME_UNKNOWN`, parciales y `PARTIAL_UPLOAD`).
- Soporte de Jira Service Management: comentarios internos y públicos con control de
  visibilidad, cargas multipart y referencias temporales de adjuntos.
- Menciones de usuarios con resolución de identidad y validación de audiencia
  (`MENTION_AMBIGUOUS`, `MENTION_NOT_ALLOWED`, `MENTION_NOT_SUPPORTED`).
- Representación bidireccional Markdown ↔ ADF para comentarios y descripciones.
- Cargas de archivos a tickets Platform y JSM con límites de tamaño y `overwrite=false`.
- Instalador global aislado: copia verificada del paquete por hash, registro de instrucciones
  y configuración con ediciones mínimas JSONC, actualización y desinstalación que conservan
  cuentas, personalizaciones y estado de ejecuciones pendientes.
- CLI de operador: `install --global`, `check --global`, `status --global` y
  `uninstall --global`, siempre con plan previo y aceptación explícita en terminal humana.
- Métricas de operación con etiquetas de baja cardinalidad y resumen global del operador.

### Seguridad

- Sin credenciales, tokens ni perfiles de cuenta en la configuración registrada, el manifiesto
  del instalador o sus registros; las cuentas se exportan de forma privada al desinstalar.
- Sin `preinstall`/`install`/`postinstall`; instalar, actualizar, desinstalar y empaquetar no
  conecta a Jira ni ejecuta pasos de red.
- Revisión humana obligatoria en terminal antes de cualquier escritura o carga; sin `--yes`
  ni aceptación por tubería.
- El instalador conserva el orden y el efecto de las reglas `allow`/`ask`/`deny` existentes y
  nunca las relaja para conseguir acceso.
- Registros sin cuerpos de tickets, cabeceras de autenticación ni datos personales; los
  secretos no se copian al chat, a logs ni al manifiesto.
