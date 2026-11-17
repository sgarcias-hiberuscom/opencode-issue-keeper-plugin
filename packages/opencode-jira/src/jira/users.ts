import { z } from "zod";
import type { Account, Config } from "../config.js";
import type { Mentions } from "../core/inputs.js";
import type { Candidate, CandidatePage, ReadResult, Ticket } from "../core/ticket.js";
import type { Cursors } from "../core/cursors.js";
import type { HttpClient } from "../http.js";
import { invalidResponse, IssueKeeperError } from "../errors.js";
import { jsmPage, parse, UserSchema } from "./schemas.js";

export async function mentionCandidates(
  http: HttpClient, cursors: Cursors, config: Config, account: Account, input: Mentions,
  ticket: Ticket, signal: AbortSignal, warnings: string[],
): Promise<ReadResult<CandidatePage>> {
  if (input.audience !== "ticket" && !ticket.serviceRequest) {
    throw new IssueKeeperError("CAPABILITY_NOT_SUPPORTED", "La audiencia internal/public requiere una solicitud JSM accesible.");
  }
  const size = input.maxResults ?? config.output.pageSize;
  if (size > config.output.maxPageSize) throw new IssueKeeperError("VALIDATION_FAILED", "Página superior al máximo configurado.");
  const scope = cursors.scope(["mentions", account.id, account.siteUrl, ticket.id, ticket.key, input.audience, input.visibility, input.query, input.accountId, size]);
  const previous = cursors.get(input.cursor, scope);
  const position: { source: "reporter" | "platform" | "participants"; start: number } = previous
    ? JSON.parse(String(previous.position)) : { source: input.audience === "public" ? "reporter" : "platform", start: 0 };
  const values: Candidate[] = [];
  const matches = (person: { accountId: string; displayName?: string; active?: boolean }) => person.active !== false
    && (input.accountId ? person.accountId === input.accountId : (person.displayName ?? "").toLocaleLowerCase().includes(input.query!.toLocaleLowerCase()));
  function add(person: { accountId: string; displayName?: string; active?: boolean }, origin: Candidate["origins"][number]) {
    if (person.active === false || input.accountId && person.accountId !== input.accountId) return;
    const validated = !input.visibility && (input.audience === "ticket" || input.audience === "public" && origin !== "platform");
    const existing = values.find((v) => v.accountId === person.accountId);
    if (existing) {
      if (!existing.origins.includes(origin)) existing.origins.push(origin);
      if (validated) { existing.validation = "validated"; delete existing.reason; }
    } else values.push({
      accountId: person.accountId, displayName: person.displayName, origins: [origin],
      validation: validated ? "validated" : "unverified",
      ...(validated ? {} : { reason: "No se ha verificado la pertenencia a la audiencia o restricción de visibilidad." }),
    });
  }
  let next: typeof position | undefined;
  if (position.source === "reporter") {
    if (ticket.reporter) {
      const reporter = { accountId: ticket.reporter.id, displayName: ticket.reporter.displayName };
      if (matches(reporter)) add(reporter, "reporter");
    }
    next = { source: "platform", start: 0 };
  } else if (position.source === "platform") {
    const params = new URLSearchParams({ issueKey: ticket.key, startAt: String(position.start), maxResults: String(size) });
    if (input.accountId) params.set("accountId", input.accountId);
    else params.set("query", input.query!);
    let people: z.infer<typeof UserSchema>[];
    try { people = parse(z.array(UserSchema), await http.json(account, `rest/api/3/user/viewissue/search?${params}`, signal)); }
    catch (error) {
      if (input.audience !== "public" || !(error instanceof IssueKeeperError) || !["FORBIDDEN", "NOT_FOUND_OR_NO_ACCESS"].includes(error.code)) throw error;
      people = [];
      warnings = [...warnings, "No se pudo consultar candidatos Platform; se continúa sólo con informador y participantes JSM visibles."];
    }
    if (people.length > size) invalidResponse();
    for (const person of people) add(person, "platform");
    if (people.length === size) next = { source: "platform", start: position.start + people.length };
    else if (input.audience === "public") next = { source: "participants", start: 0 };
  } else {
    const raw = parse(jsmPage(UserSchema), await http.json(account, `rest/servicedeskapi/request/${ticket.key}/participant?start=${position.start}&limit=${size}`, signal));
    if (raw.start !== position.start || raw.size !== raw.values.length || raw.values.length > size || raw.values.length > raw.limit || !raw.isLastPage && !raw.size) invalidResponse();
    for (const person of raw.values) if (matches(person)) add(person, "participant");
    if (!raw.isLastPage) next = { source: "participants", start: position.start + raw.size };
  }
  const names = values.map((v) => v.displayName?.toLocaleLowerCase()).filter(Boolean);
  return {
    data: {
      account: account.id, issueKey: ticket.key, audience: input.audience, visibility: input.visibility,
      values, ambiguous: new Set(names).size !== names.length, isLast: !next,
      cursor: cursors.next(scope, next ? JSON.stringify(next) : undefined, previous),
    },
    warnings: [...warnings,
      "Un resultado vacío no prueba que una persona no exista. Un candidato no autoriza una mención. Esta fase solo consulta candidatos: no prepara propuestas ni publica comentarios.",
      "La ambigüedad se indica para esta página; no seleccione automáticamente una identidad entre páginas.",
      ...(next ? ["Búsqueda incompleta (isLast=false): no ha identificado una persona única, aunque esta página tenga un solo candidato validated o informador. Continúe con el cursor o pida aclaración; no elija por origen o validación."] : []),
    ],
  };
}
