import { z } from "zod";
import type { Account } from "../config.js";
import type { CredentialLease } from "../credentials.js";
import { IssueKeeperError, invalidResponse } from "../errors.js";
import type { HttpClient } from "../http.js";

const Person = z.looseObject({ accountId: z.string().min(1).max(256), active: z.boolean(), displayName: z.string().max(256).optional() });
const Group = z.looseObject({ name: z.string().min(1), groupId: z.string().min(1) });
const Role = z.looseObject({ name: z.string(), id: z.number().int().positive() });
const Actors = z.looseObject({ actors: z.array(z.looseObject({
  actorUser: z.looseObject({ accountId: z.string() }).optional(), actorGroup: Group.optional(),
})).max(5000) });
function parse<T>(schema: z.ZodType<T>, raw: unknown): T { const result = schema.safeParse(raw); if (!result.success) invalidResponse(); return result.data; }
function denied(): never { throw new IssueKeeperError("FORBIDDEN", "No se acredita el acceso de la persona a la audiencia o su asignación en este ticket."); }
export interface AudienceTicket { issueKey: string; projectKey: string; reporterId?: string; serviceDeskId?: string }

export class AudienceValidator {
  constructor(private readonly http: HttpClient) {}
  private read(account: Account, path: string, credential: CredentialLease, signal: AbortSignal) { return this.http.jsonBound(account, path, credential, signal); }

  async visibility(account: Account, visibility: { type: "role" | "group"; value: string }, credential: CredentialLease, signal: AbortSignal): Promise<{ type: "role" | "group"; value: string; identifier: string }> {
    if (visibility.type === "role") return { ...visibility, identifier: visibility.value };
    const groups = parse(z.array(Group).max(5000), await this.read(account, `rest/api/3/user/groups?accountId=${encodeURIComponent(credential.identity)}`, credential, signal));
    const matching = groups.filter((group) => group.name === visibility.value);
    if (matching.length !== 1) denied();
    return { type: "group", value: matching[0]!.name, identifier: matching[0]!.groupId };
  }

  async assignable(account: Account, issueKey: string, accountId: string, credential: CredentialLease, signal: AbortSignal): Promise<void> {
    const people = parse(z.array(Person).max(100), await this.read(account, `rest/api/3/user/assignable/search?issueKey=${encodeURIComponent(issueKey)}&accountId=${encodeURIComponent(accountId)}&maxResults=100`, credential, signal));
    if (!people.some((person) => person.accountId === accountId && person.active)) denied();
  }
  private async role(account: Account, projectKey: string, name: string, person: string, credential: CredentialLease, signal: AbortSignal): Promise<void> {
    const roles = parse(z.array(Role).max(1000), await this.read(account, `rest/api/3/project/${projectKey}/roledetails`, credential, signal)).filter((role) => role.name === name);
    if (roles.length !== 1) denied();
    const details = parse(Actors, await this.read(account, `rest/api/3/project/${projectKey}/role/${roles[0]!.id}`, credential, signal));
    if (details.actors.some((actor) => actor.actorUser?.accountId === person)) return;
    const groups = parse(z.array(Group).max(5000), await this.read(account, `rest/api/3/user/groups?accountId=${encodeURIComponent(person)}`, credential, signal));
    if (!details.actors.some((actor) => actor.actorGroup && groups.some((group) => group.groupId === actor.actorGroup!.groupId))) denied();
  }

  async mention(account: Account, ticket: AudienceTicket, personId: string, audience: "ticket" | "internal" | "public", visibility: { type: "role" | "group"; value: string } | undefined, credential: CredentialLease, signal: AbortSignal): Promise<{ accountId: string; displayName?: string }> {
    try { return await this.person(account, ticket, personId, audience, visibility, credential, signal); }
    catch (error) {
      if (error instanceof IssueKeeperError) {
        if (error.code === "FORBIDDEN") throw new IssueKeeperError("MENTION_NOT_ALLOWED", "No se acredita el acceso de la persona a la audiencia; no se publicará la mención ni se cambiará el destino.");
        if (error.code === "NOT_FOUND_OR_NO_ACCESS") throw new IssueKeeperError("MENTION_UNRESOLVED", "No se ha podido identificar una persona accesible para esta mención; solicite una identidad verificable.");
        if (error.code === "CAPABILITY_NOT_SUPPORTED") throw new IssueKeeperError("MENTION_NOT_SUPPORTED", "No se puede verificar la mención en este contexto; no se publicará como texto ni en otra audiencia.");
      }
      throw error;
    }
  }

  async person(account: Account, ticket: AudienceTicket, personId: string, audience: "ticket" | "internal" | "public", visibility: { type: "role" | "group"; value: string } | undefined, credential: CredentialLease, signal: AbortSignal): Promise<{ accountId: string; displayName?: string }> {
    if (!/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/.test(ticket.issueKey) || !/^[A-Z][A-Z0-9_]*$/.test(ticket.projectKey) || !personId || personId.length > 256) denied();
    if (audience !== "ticket" && (!account.serviceManagement.enabled || !ticket.serviceDeskId || visibility)) denied();
    const person = parse(Person, await this.read(account, `rest/api/3/user?accountId=${encodeURIComponent(personId)}&expand=applicationRoles`, credential, signal));
    if (!person.active || person.accountId !== personId) denied();
    if (audience === "public") {
      if (ticket.reporterId !== personId) {
        let found = false;
        for (let start = 0; start < 10000; start += 100) {
          const page = parse(z.looseObject({ values: z.array(Person.omit({ active: true })).max(100), isLastPage: z.boolean() }), await this.read(account, `rest/servicedeskapi/request/${ticket.issueKey}/participant?start=${start}&limit=100`, credential, signal));
          found ||= page.values.some((item) => item.accountId === personId);
          if (found || page.isLastPage) break;
        }
        if (!found) denied();
      }
    } else {
      const access = parse(z.array(Person).max(100), await this.read(account, `rest/api/3/user/viewissue/search?issueKey=${ticket.issueKey}&accountId=${encodeURIComponent(personId)}&maxResults=100`, credential, signal));
      if (!access.some((item) => item.accountId === personId && item.active)) denied();
      if (audience === "internal") {
        const licensed = parse(z.looseObject({ applicationRoles: z.looseObject({ size: z.number().int().nonnegative(), items: z.array(z.looseObject({ key: z.string() })).max(100) }) }), person).applicationRoles;
        if (licensed.size !== licensed.items.length || !licensed.items.some((role) => role.key === "jira-servicedesk")) denied();
        await this.role(account, ticket.projectKey, "Service Desk Team", personId, credential, signal);
      } else if (visibility?.type === "role") await this.role(account, ticket.projectKey, visibility.value, personId, credential, signal);
      else if (visibility?.type === "group") {
        const groups = parse(z.array(Group).max(5000), await this.read(account, `rest/api/3/user/groups?accountId=${encodeURIComponent(personId)}`, credential, signal));
        if (!groups.some((group) => group.name === visibility.value)) denied();
      }
    }
    return { accountId: person.accountId, ...(person.displayName ? { displayName: person.displayName } : {}) };
  }
}
