export type ErrorCode =
  | "CONFIG_INVALID" | "ACCOUNT_UNAVAILABLE" | "AUTH_FAILED" | "FORBIDDEN"
  | "NOT_FOUND_OR_NO_ACCESS" | "VALIDATION_FAILED" | "CONFLICT" | "RATE_LIMITED"
  | "TIMEOUT" | "NETWORK_ERROR" | "CANCELLED" | "RESPONSE_TOO_LARGE"
  | "INVALID_RESPONSE" | "CAPABILITY_NOT_SUPPORTED" | "FILE_ACCESS_DENIED"
  | "ATTACHMENT_TOO_LARGE" | "TRANSFER_INCOMPLETE" | "CURSOR_INVALID";

export class IssueKeeperError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "IssueKeeperError";
  }
}

export function invalidResponse(): never {
  throw new IssueKeeperError("INVALID_RESPONSE", "Respuesta Jira no válida; compruebe API, permisos y versión.");
}

export function cancellation(signal: AbortSignal): void {
  if (signal.aborted) throw new IssueKeeperError("CANCELLED", "Operación cancelada.");
}

export function httpError(status: number, retryAfter?: number): IssueKeeperError {
  const errors: Partial<Record<number, [ErrorCode, string]>> = {
    400: ["VALIDATION_FAILED", "Jira rechazó los parámetros; revise filtros y campos."],
    401: ["AUTH_FAILED", "Revise email, token, modo de autenticación y expiración."],
    403: ["FORBIDDEN", "Acceso denegado; revise proyectos, permisos y scopes."],
    404: ["NOT_FOUND_OR_NO_ACCESS", "Recurso no encontrado o no accesible con esta cuenta."],
    409: ["CONFLICT", "El recurso ha cambiado; vuelva a consultarlo."],
    413: ["RESPONSE_TOO_LARGE", "La petición o respuesta excede el límite remoto."],
    422: ["VALIDATION_FAILED", "Jira no admite los parámetros indicados."],
    429: ["RATE_LIMITED", "Límite de peticiones alcanzado; espere antes de repetir."],
  };
  const [code, message] = errors[status] ?? ["NETWORK_ERROR", "Jira devolvió una respuesta HTTP inesperada."];
  return new IssueKeeperError(code, message, status === 429 || [502, 503, 504].includes(status), retryAfter);
}
