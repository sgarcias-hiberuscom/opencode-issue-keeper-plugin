# Prototipo offline de persistencia — fase 2

Este directorio conserva el ensayo inicial **VIA-01**, no el almacén de producción del
plugin. No se importa desde `src/`, no se distribuye en el tarball y no registra
herramientas ni envía peticiones a Jira. Los planes y efectos laterales son
exclusivamente sintéticos. Ninguna prueba aquí acredita autorización humana,
formato/menciones JSM o escrituras REAL.

La implementación posterior usa `better-sqlite3` fijado, no este driver
experimental: véanse `src/state/` y `test/contract/state.test.ts` desde la raíz
del paquete. `test:phase2:storage` ejecuta tanto este ensayo histórico como la
regresión del almacén nuevo. La selección de driver/ruta/política aprobada se
documenta en el README del paquete; las limitaciones pendientes de este ensayo
no describen automáticamente el estado de la implementación posterior.

## Ejecución

Desde `packages/opencode-jira`, con las dependencias de desarrollo instaladas:

```sh
npm run test:phase2:storage
npm run typecheck
npm run phase2:baseline
```

La misma suite se incluye en `test:mock` y, por tanto, en la matriz offline de CI
Node 22/24. Los workers se ejecutan con el mismo binario Node que Vitest, sin
heredar variables de entorno ni credenciales. Necesitan `node:sqlite` y
`--experimental-strip-types`. Los directorios temporales privados se crean bajo
`/tmp/opencode` y se retiran al terminar. No se usan cuentas ni inventario del
laboratorio. La prueba de caída usa `SIGKILL`, no un cierre simulado.

## Alternativa ensayada para D-03/D-04/D-13

- SQLite incorporado en Node mediante `DatabaseSync`, **experimental** en el
  runtime Node 22 comprobado. No se incorpora una dependencia nueva, no se
  cambia `engines` y no se presume estabilidad o disponibilidad en cualquier
  versión `>=22`. Su licencia/versionado dependen de la distribución Node;
  el informe privado registra Node y SQLite efectivamente usados.
- Un único propietario vivo por directorio, mediante una transacción
  `BEGIN EXCLUSIVE` en `owner.sqlite`. El bloqueo lo libera el sistema al morir
  el proceso; no se usan PID, caducidades de lease ni borrado de locks ajenos.
- El journal de negocio usa otro archivo, `state.sqlite`, con transacciones
  `BEGIN IMMEDIATE`, rollback journal `DELETE`, `synchronous=FULL`, claves
  foráneas, versión y application ID. La transacción de propiedad no impide
  confirmar el progreso. La creación inicial sincroniza también el directorio.
- Directorio dedicado existente 0700, archivos 0600, propietario actual,
  archivos regulares sin symlinks/hardlinks. No se corrigen permisos ajenos ni
  se recrea una base corrupta/incompatible. El llamante suministra la ruta del
  ensayo: **no se ha fijado aún una ruta pública de datos del plugin**.
- Plan JSON canónico acotado y hash SHA-256, separado de progreso, recibos y
  eventos. El hash cubre todo el plan sintético, no sólo el payload. Las lecturas
  devuelven copias; mutarlas no modifica lo persistido. El hash detecta
  corrupción accidental, no autentica datos frente a otro proceso del mismo UID.
- Revisión CAS por ejecución y reclamación por sitio/ID canónico del ticket,
  compartida entre alias. Los estados inciertos retienen la reclamación.
- `sending` se confirma antes de devolver control al emisor sintético; fallo de
  persistencia impide ese envío. Al recuperar, `applying` pasa a `unknown` y
  `sending` a `unknown`, preservando recibos anteriores. No hay reenvío ni
  continuación automática. Confirmación y verificación son hechos distintos.
- TTL impide reclamar/iniciar pasos caducados. No elimina planes, recibos o
  progreso. Un resultado confirmado/verificado sigue consultable. Esto ensaya
  una alternativa para D-12; no decide el contrato público de aplicación.

## Cobertura y límites

La suite `test/contract/persistence-prototype.test.ts` cubre hash/aislamiento de
copias, CAS, segundo proceso, alias/sitio, caída en reclamación/envío/aceptación/
recibo/verificación, rollback de transacción interrumpida, fallo antes de commit,
progreso por fase, TTL, archivos inseguros, corrupción y esquema incompatible.
El ledger de aceptación es un archivo sintético, **no un servidor HTTP ni Jira**.

`phase2:baseline` guarda un manifiesto privado 0600 en `reports/phase2/`, con
commit, versiones, hashes SHA-256 de fuentes en HEAD y en el árbol de trabajo
(incluidos archivos nuevos no ignorados). No sigue symlinks, no inspecciona la
copia activa ni configuración/credenciales y no ejecuta suites. No sustituye el
inventario autorizado pendiente de PRE-01/PRE-02.

El alcance candidato es Linux y disco local de un único usuario/host. No se
acreditan NFS, Windows, bloqueo frente a programas que ignoren el protocolo,
resistencia a un actor del mismo UID, corte eléctrico/fallo físico de disco ni
`exactly once` remoto. El fallo antes de commit es una inyección controlada; no
equivale a una campaña completa de ENOSPC/EIO.

Faltan para adoptar el diseño: comprobar Node 24, evaluar un driver estable y su
tarball independiente, resolver rutas/cuotas/retención/migración, coordinar el
instalador con el mismo propietario y verificar quiescencia mientras haya red
activa. El prototipo no contiene un emisor, por lo que su `close()` no demuestra
el cierre protegido de un runtime que esté transmitiendo. No hay interfaz de
operador, reconciliación por evidencia remota, purga, staging, permisos nativos
ni validadores de payload Jira. Los tipos `Synthetic*` no son contratos públicos.

**Estado:** alternativa evaluable, no decisión aceptada. No cierra EST, APL,
REC, INS ni G1/G2. Mantener `remoteWrites: false` y las ocho herramientas hasta
cumplir las puertas del desglose; no migrar este prototipo a producción por el
mero hecho de que sus pruebas pasen.
