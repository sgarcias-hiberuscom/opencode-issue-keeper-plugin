export type ErrorCode =
  | "CONFIG_INVALID" | "ACCOUNT_UNAVAILABLE" | "AUTH_FAILED" | "FORBIDDEN"
  | "NOT_FOUND_OR_NO_ACCESS" | "VALIDATION_FAILED" | "CONFLICT" | "RATE_LIMITED"
  | "TIMEOUT" | "NETWORK_ERROR" | "REDIRECT_NOT_ALLOWED" | "RESPONSE_TOO_LARGE"
  | "INVALID_RESPONSE" | "CAPABILITY_NOT_SUPPORTED" | "FILE_ACCESS_DENIED"
  | "ATTACHMENT_TOO_LARGE" | "TRANSFER_INCOMPLETE" | "PARTIAL_UPLOAD" | "CURSOR_INVALID" | "FORMAT_INVALID" | "FORMAT_NOT_SUPPORTED"
  | "MENTION_UNRESOLVED" | "MENTION_AMBIGUOUS" | "MENTION_NOT_ALLOWED" | "MENTION_NOT_SUPPORTED"
  | "WRITE_OUTCOME_UNKNOWN" | "PROPOSAL_EXPIRED" | "PROPOSAL_INVALID" | "FILE_CHANGED";

export class IssueKeeperError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "IssueKeeperError";
  }
}

export function invalidResponse(): never {
  throw new IssueKeeperError("INVALID_RESPONSE", "Respuesta Jira no válida; compruebe API, permisos y versión.");
}

export function cancellation(signal: AbortSignal): void {
  signal.throwIfAborted();
}

export { IssueKeeperError as ApplicationError };

export function validationFailure(issues: readonly { path: PropertyKey[]; code: string }[]): IssueKeeperError {
  const known = new Set(["account", "issueKey", "fields", "jql", "maxResults", "cursor", "audience", "visibility", "type", "value", "query", "accountId", "attachmentId", "destinationName", "format"]);
  const fieldErrors = Object.fromEntries(issues.map((issue) => [
    issue.path.every((part) => typeof part === "number" || known.has(String(part))) ? issue.path.join(".") || "input" : "input",
    "Valor no válido; consulte el esquema.",
  ]));
  const format = issues.some((issue) => issue.path.length === 1 && (issue.path[0] === "format" || ["text", "comment"].includes(String(issue.path[0])) && issue.code === "too_big"));
  return new IssueKeeperError(format ? "FORMAT_INVALID" : "VALIDATION_FAILED", format ? "Formato no válido o contenido excesivo; corrija la entrada sin reinterpretarla automáticamente como plain." : "Argumentos no válidos; consulte el esquema de la herramienta.", false, undefined, fieldErrors);
}

export function applicationFailure(error: IssueKeeperError, requestId: string, account?: string, warnings: string[] = []) {
  return { ok: false, account, warnings,
    error: { code: error.code, message: error.message, retryable: error.retryable, retryAfterSeconds: error.retryAfterSeconds, fieldErrors: error.fieldErrors },
    meta: { requestId, truncated: false, untrustedContent: true },
  };
}

export function httpError(status: number, retryAfter?: number, jsm = false): IssueKeeperError {
  const errors: Partial<Record<number, [ErrorCode, string]>> = {
    400: ["VALIDATION_FAILED", "Jira rechazó los parámetros; revise filtros y campos."],
    401: ["AUTH_FAILED", "Revise email, token, modo de autenticación y expiración."],
    403: ["FORBIDDEN", jsm ? "Acceso JSM denegado; pueden influir el rol de agente/cliente, permisos y scopes JSM." : "Acceso denegado; revise proyectos, permisos y scopes."],
    404: ["NOT_FOUND_OR_NO_ACCESS", "Recurso no encontrado o no accesible con esta cuenta."],
    409: ["CONFLICT", "El recurso ha cambiado; vuelva a consultarlo."],
    413: ["RESPONSE_TOO_LARGE", "La petición o respuesta excede el límite remoto."],
    422: ["VALIDATION_FAILED", "Jira no admite los parámetros indicados."],
    429: ["RATE_LIMITED", "Límite de peticiones alcanzado; espere antes de repetir."],
  };
  const [code, message] = errors[status] ?? ["NETWORK_ERROR", "Jira devolvió una respuesta HTTP inesperada."];
  return new IssueKeeperError(code, message, status === 429 || [500, 502, 503, 504].includes(status), retryAfter);
}
