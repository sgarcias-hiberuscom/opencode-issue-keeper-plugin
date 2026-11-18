import { setTimeout as delay } from "node:timers/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Account, Config } from "./config.js";
import { authorization, boundAuthorization, captureCredential, type CredentialLease } from "./credentials.js";
import { mutationRequest, MutationUncertainError, type JiraMutation, type MutationResponse } from "./jira/mutations.js";
import { pinnedMultipart } from "./state/multipart.js";
import type { PinnedFile } from "./core/proposals.js";
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
  if (!/^rest\/(?:api\/3\/(?:myself|mypermissions|user(?:\/(?:viewissue\/search|assignable\/search|groups))?|project\/[A-Z][A-Z0-9_]*(?:\/roledetails|\/role(?:\/[0-9]+)?)|search\/jql|issue\/[A-Z][A-Z0-9_]*-[1-9][0-9]*(?:\/comment(?:\/[0-9]+)?|\/editmeta|\/transitions|\/attachments)?|attachment\/(?:meta|(?:content\/)?[0-9]+))|servicedeskapi\/(?:servicedesk(?:\/[0-9]+\/attachTemporaryFile)?|request\/[A-Z][A-Z0-9_]*-[1-9][0-9]*(?:\/comment(?:\/[0-9]+)?|\/participant|\/attachment(?:\/[0-9]+)?)?))(?:\?[^#\\]*)?$/.test(path)
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

function mediaDestination(location: string | null): URL {
  try {
    const target = new URL(location ?? "");
    if (target.origin === "https://api.media.atlassian.com" && !target.username && !target.password && !target.hash
      && /^\/file\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/binary$/i.test(target.pathname)) return target;
  } catch { /* Invalid remote locations must not appear in diagnostics. */ }
  throw new IssueKeeperError("REDIRECT_NOT_ALLOWED", "Redirección bloqueada: no se ha validado un destino autorizado.");
}

export class HttpClient {
  private readonly shutdown = new AbortController();
  private readonly sites = new Map<string, Semaphore>();
  private readonly accounts = new Map<string, Semaphore>();
  private readonly revalidation = new AsyncLocalStorage<{ account: string; site: string; gate: Semaphore; signal: AbortSignal; active: boolean }>();
  constructor(private readonly config: Config, private readonly fetcher: typeof fetch = fetch) {}

  close(): void { this.shutdown.abort(); }

  private queues(account: Account): [Semaphore, Semaphore] {
    let site = this.sites.get(account.siteUrl);
    if (!site) { site = new Semaphore(this.config.http.maxConcurrentPerAccount); this.sites.set(account.siteUrl, site); }
    let alias = this.accounts.get(account.id);
    if (!alias) { alias = new Semaphore(this.config.http.maxConcurrentPerAccount); this.accounts.set(account.id, alias); }
    return [site, alias];
  }

  private async acquire(account: Account, signal: AbortSignal): Promise<() => void> {
    const borrowed = this.revalidation.getStore();
    if (borrowed) {
      if (!borrowed.active || borrowed.account !== account.id || borrowed.site !== account.siteUrl) throw new IssueKeeperError("CONFLICT", "Revalidación fuera del contexto protegido de envío.");
      const release = await borrowed.gate.acquire(signal);
      if (!borrowed.active) { release(); throw new IssueKeeperError("CONFLICT", "La revalidación de envío ya terminó."); }
      return release;
    }
    const [site, alias] = this.queues(account);
    const releaseAlias = await alias.acquire(signal);
    try { const releaseSite = await site.acquire(signal); return () => { releaseSite(); releaseAlias(); }; }
    catch (error) { releaseAlias(); throw error; }
  }

  identityForWrite(account: Account, signal: AbortSignal): Promise<CredentialLease> {
    return captureCredential(account, async (header) => {
      const data = await this.read(account, "rest/api/3/myself", signal, (response, combined) => readJson(response, this.config.http.maxResponseBytes, combined), undefined, false, header);
      if (!data || typeof data !== "object" || !("accountId" in data) || typeof data.accountId !== "string" || !("active" in data) || data.active !== true) invalidResponse();
      return data.accountId;
    });
  }

  async mutate(account: Account, input: JiraMutation, credential: CredentialLease, signal: AbortSignal, beforeSend: () => Promise<void>): Promise<MutationResponse> {
    cancellation(signal);
    if (account.readOnly) throw new IssueKeeperError("FORBIDDEN", "La cuenta es de sólo lectura.");
    const request = mutationRequest(input);
    return this.dispatchMutation(account, { ...request, headers: { "Content-Type": "application/json" } }, credential, signal, beforeSend);
  }

  async upload(account: Account, target: { kind: "platform"; issueKey: string } | { kind: "jsm-temporary"; serviceDeskId: string }, staging: string, file: PinnedFile, credential: CredentialLease, signal: AbortSignal, beforeSend: () => Promise<void>): Promise<MutationResponse> {
    cancellation(signal);
    if (this.revalidation.getStore()) throw new IssueKeeperError("FORBIDDEN", "No se admiten cargas anidadas en una revalidación.");
    if (account.readOnly || !this.config.attachments.enabled) throw new IssueKeeperError("FORBIDDEN", "La carga no está habilitada para esta cuenta.");
    if (file.size > this.config.attachments.maxFileBytes) throw new IssueKeeperError("ATTACHMENT_TOO_LARGE", "El archivo preparado supera el límite local.");
    if (target.kind === "platform" ? !/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/.test(target.issueKey) : target.kind !== "jsm-temporary" || !/^\d+$/.test(target.serviceDeskId) || !account.serviceManagement.enabled) throw new IssueKeeperError("VALIDATION_FAILED", "Destino de carga no válido.");
    const deadline = AbortSignal.timeout(this.config.attachments.transferTimeoutMs);
    let multipart;
    try {
      multipart = await pinnedMultipart(staging, file, AbortSignal.any([signal, this.shutdown.signal, deadline]));
      return await this.dispatchMutation(account, { method: "POST", path: target.kind === "platform" ? `rest/api/3/issue/${target.issueKey}/attachments` : `rest/servicedeskapi/servicedesk/${target.serviceDeskId}/attachTemporaryFile`, status: target.kind === "platform" ? 200 : 201,
        body: multipart.body, headers: { "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`, "Content-Length": String(multipart.contentLength), "X-Atlassian-Token": "no-check" } }, credential, signal, beforeSend, true, deadline);
    } catch (error) {
      if (!multipart) {
        if (signal.aborted) throw signal.reason;
        if (this.shutdown.signal.aborted) throw this.shutdown.signal.reason;
        if (deadline.aborted) throw new IssueKeeperError("TIMEOUT", "Tiempo agotado verificando el archivo antes del envío.");
        throw new IssueKeeperError("FILE_CHANGED", "El staging falta, cambió o no es seguro; no se enviará un archivo sustituto.");
      }
      throw error;
    } finally { await multipart?.close(); }
  }

  private async dispatchMutation(account: Account, request: { method: string; path: string; body: BodyInit; headers: Record<string, string>; status: number }, credential: CredentialLease, signal: AbortSignal, beforeSend: () => Promise<void>, binary = false, deadline?: AbortSignal): Promise<MutationResponse> {
    if (this.revalidation.getStore()) throw new IssueKeeperError("FORBIDDEN", "No se admiten mutaciones anidadas en una revalidación.");
    const url = apiUrl(account, request.path);
    const timeout = AbortSignal.timeout(binary ? this.config.attachments.transferTimeoutMs : this.config.http.timeoutMs);
    const combined = AbortSignal.any([signal, this.shutdown.signal, timeout, ...(deadline ? [deadline] : [])]);
    let release: (() => void) | undefined;
    let attempted = false;
    try {
      release = await this.acquire(account, combined);
      const header = await boundAuthorization(credential, account);
      cancellation(combined);
      // Validation reads borrow this still-unused HTTP slot serially, including at a concurrency limit of one.
      const validation = { account: account.id, site: account.siteUrl, gate: new Semaphore(1), signal: combined, active: true };
      try { await this.revalidation.run(validation, beforeSend); }
      finally {
        validation.active = false;
        const drain = await validation.gate.acquire(new AbortController().signal); drain();
      }
      await boundAuthorization(credential, account);
      cancellation(combined);
      const operation = operations.getStore(); if (operation) operation.attempts++;
      attempted = true;
      const response = await this.fetcher(url, { method: request.method, headers: { Authorization: header, Accept: "application/json", ...request.headers }, body: request.body, redirect: "manual", signal: combined, ...(binary ? { duplex: "half" } : {}) });
      if (operation) operation.status = response.status;
      try {
        if ([400, 401, 403, 404, 409, 413, 415, 422, 429].includes(response.status)) return { outcome: "rejected", status: response.status };
        if (response.status !== request.status) throw new MutationUncertainError("response");
        const data = await readJson(response, this.config.http.maxResponseBytes, combined);
        return { outcome: "confirmed", status: response.status, data };
      } finally { await response.body?.cancel().catch(() => {}); }
    } catch (error) {
      if (!attempted) {
        if (signal.aborted) throw signal.reason;
        if (this.shutdown.signal.aborted) throw this.shutdown.signal.reason;
        if (timeout.aborted || deadline?.aborted) throw new IssueKeeperError("TIMEOUT", "Tiempo agotado antes del envío.");
        throw error;
      }
      if (signal.aborted || this.shutdown.signal.aborted) throw new MutationUncertainError("cancelled", signal.aborted ? signal.reason : this.shutdown.signal.reason);
      if (timeout.aborted || deadline?.aborted) throw new MutationUncertainError("timeout");
      if (error instanceof MutationUncertainError) throw error;
      throw new MutationUncertainError("transport");
    } finally { release?.(); }
  }

  json(account: Account, path: string, signal: AbortSignal, search?: unknown): Promise<unknown> {
    return this.read(account, path, signal, (response, combined) => readJson(response, this.config.http.maxResponseBytes, combined), search);
  }

  async jsonBound(account: Account, path: string, credential: CredentialLease, signal: AbortSignal): Promise<unknown> {
    const header = await boundAuthorization(credential, account);
    return this.read(account, path, signal, (response, combined) => readJson(response, this.config.http.maxResponseBytes, combined), undefined, false, header);
  }

  async tenant(account: Account, signal: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.config.http.timeoutMs);
    const borrowed = this.revalidation.getStore();
    const combined = AbortSignal.any([signal, this.shutdown.signal, timeout, ...(borrowed ? [borrowed.signal] : [])]);
    let release: (() => void) | undefined;
    try {
      cancellation(combined);
      release = await this.acquire(account, combined);
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
    } finally { release?.(); }
  }

  async read<T>(
    account: Account, path: string, signal: AbortSignal,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
    search?: unknown, binary = false, credentialHeader?: string,
  ): Promise<T> {
    const url = apiUrl(account, path);
    if (search !== undefined && path !== "rest/api/3/search/jql") throw new IssueKeeperError("FORBIDDEN", "Sólo está permitido POST de búsqueda.");
    const timeoutMs = binary ? this.config.attachments.transferTimeoutMs : this.config.http.timeoutMs;
    const deadline = Date.now() + timeoutMs;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    timer.unref();
    const borrowed = this.revalidation.getStore();
    const combined = AbortSignal.any([signal, this.shutdown.signal, timeout.signal, ...(borrowed ? [borrowed.signal] : [])]);
    let release: (() => void) | undefined;
    try {
      cancellation(combined);
      const auth = credentialHeader ?? await authorization(account);
      const attempts = binary ? 1 : this.config.http.readMaxAttempts;
      for (let attempt = 1; ; attempt++) {
        cancellation(combined);
        try {
          release = await this.acquire(account, combined);
          cancellation(combined);
          const operation = operations.getStore();
          if (operation) operation.attempts++;
          const response = await this.fetcher(url, {
            method: search === undefined ? "GET" : "POST",
            headers: {
              Authorization: auth, Accept: binary ? "*/*" : "application/json",
              ...(search === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(search === undefined ? {} : { body: JSON.stringify(search) }),
            redirect: "manual", signal: combined,
          });
          if (operation) operation.status = response.status;
          if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            // Only binary transfers may hop, exactly once, to the validated
            // media destination over HTTPS; credentials are never forwarded
            // and the signed URL is never reported or logged.
            if (!binary || ![301, 302, 303, 307, 308].includes(response.status)) {
              throw new IssueKeeperError("REDIRECT_NOT_ALLOWED", "Redirección bloqueada: no se ha validado un destino autorizado.");
            }
            const target = mediaDestination(response.headers.get("location"));
            if (operation) operation.attempts++;
            const media = await this.fetcher(target, {
              method: "GET", headers: { Accept: "*/*" }, credentials: "omit",
              redirect: "manual", signal: combined,
            });
            if (operation) operation.status = media.status;
            if (media.status >= 300 && media.status < 400) {
              await media.body?.cancel();
              throw new IssueKeeperError("REDIRECT_NOT_ALLOWED", "Redirección bloqueada: no se ha validado un destino autorizado.");
            }
            if (!media.ok) {
              await media.body?.cancel();
              throw new IssueKeeperError("TRANSFER_INCOMPLETE", "La transferencia no llegó al destino de medios autorizado.");
            }
            try { return await consume(media, combined); }
            finally { await media.body?.cancel().catch(() => {}); }
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
          await delay(wait, undefined, { signal: combined });
        } finally {
          release?.(); release = undefined;
        }
      }
    } catch (cause) {
      if (signal.aborted) throw signal.reason;
      if (this.shutdown.signal.aborted) throw this.shutdown.signal.reason;
      if (timeout.signal.aborted) throw new IssueKeeperError("TIMEOUT", "Se agotó el tiempo de lectura; reduzca el alcance.", true);
      if (cause instanceof IssueKeeperError) throw cause;
      throw new IssueKeeperError("NETWORK_ERROR", "Fallo de red al leer Jira.", true);
    } finally { clearTimeout(timer); release?.(); }
  }
}
