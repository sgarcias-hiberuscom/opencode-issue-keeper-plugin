import { setTimeout as delay } from "node:timers/promises";
import type { Account, Config } from "./config.js";
import { authorization } from "./credentials.js";
import { cancellation, httpError, invalidResponse, IssueKeeperError } from "./errors.js";
import { operations } from "./core/operation.js";

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    cancellation(signal);
    if (this.active >= this.limit) {
      if (this.waiting.length >= 100) throw new IssueKeeperError("RATE_LIMITED", "Cola local llena; espere antes de repetir.", true);
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal.removeEventListener("abort", abort); resolve(); };
        const abort = () => {
          const index = this.waiting.indexOf(wake);
          if (index !== -1) this.waiting.splice(index, 1);
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        this.waiting.push(wake);
      });
    } else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}

export function apiUrl(account: Account, path: string): URL {
  // An allowlist also makes this transport incapable of sending arbitrary remote mutations.
  if (!/^rest\/(?:api\/3\/(?:myself|user\/viewissue\/search|search\/jql|issue\/[A-Z][A-Z0-9_]*-[1-9][0-9]*(?:\/comment)?|attachment\/(?:content\/)?[0-9]+)|servicedeskapi\/(?:servicedesk|request\/[A-Z][A-Z0-9_]*-[1-9][0-9]*(?:\/comment|\/participant|\/attachment(?:\/[0-9]+)?)?))(?:\?[^#\\]*)?$/.test(path)
    || /[\r\n]/.test(path)) throw new IssueKeeperError("VALIDATION_FAILED", "Ruta de API no autorizada.");
  const root = account.auth.mode === "cloud-scoped-token"
    ? `https://api.atlassian.com/ex/jira/${encodeURIComponent(account.auth.cloudId)}/`
    : `${account.siteUrl}/`;
  return new URL(path, root);
}

export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : undefined;
}

export async function readJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  if (response.status === 204) return undefined;
  if (!/^application\/(?:[a-z0-9.-]+\+)?json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel();
    invalidResponse();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) invalidResponse();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      cancellation(signal);
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new IssueKeeperError("RESPONSE_TOO_LARGE", "Respuesta demasiado grande; reduzca campos o página.");
      chunks.push(value);
    }
    cancellation(signal);
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { invalidResponse(); }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class HttpClient {
  private readonly shutdown = new AbortController();
  private readonly sites = new Map<string, Semaphore>();
  private readonly accounts = new Map<string, Semaphore>();
  constructor(private readonly config: Config, private readonly fetcher: typeof fetch = fetch) {}

  close(): void { this.shutdown.abort(); }

  json(account: Account, path: string, signal: AbortSignal, search?: unknown): Promise<unknown> {
    return this.read(account, path, signal, (response, combined) => readJson(response, this.config.http.maxResponseBytes, combined), search);
  }

  async tenant(account: Account, signal: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.config.http.timeoutMs);
    const combined = AbortSignal.any([signal, this.shutdown.signal, timeout]);
    try {
      cancellation(combined);
      const operation = operations.getStore();
      if (operation) operation.attempts++;
      const response = await this.fetcher(`${account.siteUrl}/_edge/tenant_info`, { method: "GET", headers: { Accept: "application/json" }, redirect: "manual", signal: combined });
      if (operation) operation.status = response.status;
      try {
        if (response.status >= 300 && response.status < 400) throw new IssueKeeperError("REDIRECT_NOT_ALLOWED", "Redirección JSON no autorizada.");
        if (!response.ok) throw httpError(response.status);
        return await readJson(response, this.config.http.maxResponseBytes, combined);
      } finally { await response.body?.cancel().catch(() => {}); }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (this.shutdown.signal.aborted) throw this.shutdown.signal.reason;
      if (timeout.aborted) throw new IssueKeeperError("TIMEOUT", "Tiempo de comprobación del sitio agotado.");
      if (error instanceof IssueKeeperError) throw error;
      throw new IssueKeeperError("NETWORK_ERROR", "No se pudo comprobar el sitio.");
    }
  }

  async read<T>(
    account: Account, path: string, signal: AbortSignal,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
    search?: unknown, binary = false,
  ): Promise<T> {
    const url = apiUrl(account, path);
    if (search !== undefined && path !== "rest/api/3/search/jql") throw new IssueKeeperError("FORBIDDEN", "Sólo está permitido POST de búsqueda.");
    const timeoutMs = binary ? this.config.attachments.transferTimeoutMs : this.config.http.timeoutMs;
    const deadline = Date.now() + timeoutMs;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    timer.unref();
    const combined = AbortSignal.any([signal, this.shutdown.signal, timeout.signal]);
    let release: (() => void) | undefined;
    let releaseAccount: (() => void) | undefined;
    try {
      cancellation(combined);
      let queue = this.sites.get(account.siteUrl);
      if (!queue) { queue = new Semaphore(this.config.http.maxConcurrentPerAccount); this.sites.set(account.siteUrl, queue); }
      let accountQueue = this.accounts.get(account.id);
      if (!accountQueue) { accountQueue = new Semaphore(this.config.http.maxConcurrentPerAccount); this.accounts.set(account.id, accountQueue); }
      const auth = await authorization(account);
      const attempts = binary ? 1 : this.config.http.readMaxAttempts;
      for (let attempt = 1; ; attempt++) {
        cancellation(combined);
        try {
          releaseAccount = await accountQueue.acquire(combined);
          release = await queue.acquire(combined);
          cancellation(combined);
          const operation = operations.getStore();
          if (operation) operation.attempts++;
          const response = await this.fetcher(url, {
            method: search === undefined ? "GET" : "POST",
            headers: {
              Authorization: auth, Accept: binary ? "application/octet-stream" : "application/json",
              ...(search === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(search === undefined ? {} : { body: JSON.stringify(search) }),
            redirect: "manual", signal: combined,
          });
          if (operation) operation.status = response.status;
          if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            throw new IssueKeeperError("REDIRECT_NOT_ALLOWED", "Redirección bloqueada: no se ha validado un destino autorizado.");
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw httpError(response.status, retryAfter(response.headers.get("retry-after")), path.startsWith("rest/servicedeskapi/"));
          }
          try { return await consume(response, combined); }
          finally { await response.body?.cancel().catch(() => {}); }
        } catch (cause) {
          if (combined.aborted) throw cause;
          const error = cause instanceof IssueKeeperError ? cause
            : new IssueKeeperError("NETWORK_ERROR", "Fallo de red al leer Jira.", true);
          if (!error.retryable || attempt >= attempts) throw error;
          const wait = Math.max((error.retryAfterSeconds ?? 0) * 1000, 250 * 2 ** (attempt - 1) + Math.random() * 250);
          if (Date.now() + wait >= deadline) throw error;
          release?.(); release = undefined;
          releaseAccount?.(); releaseAccount = undefined;
          await delay(wait, undefined, { signal: combined });
        } finally {
          release?.(); release = undefined;
          releaseAccount?.(); releaseAccount = undefined;
        }
      }
    } catch (cause) {
      if (signal.aborted) throw signal.reason;
      if (this.shutdown.signal.aborted) throw this.shutdown.signal.reason;
      if (timeout.signal.aborted) throw new IssueKeeperError("TIMEOUT", "Se agotó el tiempo de lectura; reduzca el alcance.", true);
      if (cause instanceof IssueKeeperError) throw cause;
      throw new IssueKeeperError("NETWORK_ERROR", "Fallo de red al leer Jira.", true);
    } finally { clearTimeout(timer); release?.(); releaseAccount?.(); }
  }
}
