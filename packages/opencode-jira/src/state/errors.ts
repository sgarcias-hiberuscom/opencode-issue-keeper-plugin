export type StateFailure = "UNSUPPORTED" | "UNSAFE_PATH" | "BUSY" | "CORRUPT" | "INCOMPATIBLE" | "QUOTA" | "CONFLICT" | "EXPIRED" | "NOT_FOUND" | "INVALID" | "CLOSED" | "IO";

const messages: Record<StateFailure, string> = {
  UNSUPPORTED: "La persistencia de cambios requiere Linux, hilo principal y disco local.",
  UNSAFE_PATH: "El estado local no tiene rutas, propietario o permisos seguros; no se modificará.",
  BUSY: "Otra operación o proceso utiliza el estado global de Jira; no se modificará la instalación ni se enviarán cambios.",
  CORRUPT: "El estado de cambios no supera la validación; se conserva para diagnóstico, sin recrearlo.",
  INCOMPATIBLE: "El formato de estado o de las propuestas no es compatible con este paquete; se conserva sin migrar.",
  QUOTA: "No hay espacio disponible para otra propuesta tras limpiar los resultados elegibles; los pendientes se conservan.",
  CONFLICT: "La operación cambió de revisión o no admite esa transición; no se repetirá un envío.",
  EXPIRED: "La propuesta ha caducado o no tiene vigencia temporal; prepare una nueva sin modificar los pendientes.",
  NOT_FOUND: "La propuesta no existe o ya fue retirada por retención; no se ejecutará ningún cambio.",
  INVALID: "El documento de cambio no cumple el contrato interno de persistencia.",
  CLOSED: "El almacén de cambios está cerrado.",
  IO: "No se pudo confirmar el progreso en disco; no repita la mutación y consulte su estado.",
};

// These reasons are local infrastructure diagnostics, not the public tool error catalogue.
export class StateError extends Error {
  readonly reason: StateFailure;
  constructor(reason: StateFailure) { super(messages[reason]); this.name = "StateError"; this.reason = reason; }
}
