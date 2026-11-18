import { describe, expect, it, vi } from "vitest";
import { AudienceValidator } from "../../src/jira/audience.js";
import type { HttpClient } from "../../src/http.js";
import { config } from "../helpers.js";
import { IssueKeeperError } from "../../src/errors.js";

const ticket = { issueKey: "SD-5", projectKey: "SD", reporterId: "customer", serviceDeskId: "2" };
const credential = { identity: "agent", account: "work", site: "https://example.atlassian.net" };
function fixture() {
  const c = config(true); const person = { accountId: "agent", active: true, displayName: "Agente", applicationRoles: { size: 1, items: [{ key: "jira-servicedesk" }] } };
  let roles = [{ name: "Service Desk Team", id: 10011 }]; let actors: unknown[] = [{ actorUser: { accountId: "agent" } }]; let groups: unknown[] = [];
  const read = vi.fn(async (_account: unknown, path: string) => {
    if (path.includes("/user?")) return person;
    if (path.includes("/viewissue/")) return [person];
    if (path.includes("/assignable/")) return [person];
    if (path.includes("/roledetails")) return roles;
    if (path.includes("/role/")) return { actors };
    if (path.includes("/user/groups")) return groups;
    if (path.includes("/participant")) return { values: [], isLastPage: true };
    throw new Error("unexpected read");
  });
  const validator = new AudienceValidator({ jsonBound: read } as unknown as HttpClient);
  return { c, person, read, validator, roles: (value: typeof roles) => { roles = value; }, actors: (value: unknown[]) => { actors = value; }, groups: (value: unknown[]) => { groups = value; } };
}
describe("[VIA-03][D-02][MET-03][MEN-01] explicit audience and assignment evidence", () => {
  it("requires license, ticket access and actual service-team membership for internal mentions", async () => {
    const f = fixture(); await expect(f.validator.mention(f.c.accounts[0]!, ticket, "agent", "internal", undefined, credential, new AbortController().signal)).resolves.toEqual({ accountId: "agent", displayName: "Agente" });
    expect(f.read.mock.calls.some(([, path]) => path.includes("/roledetails"))).toBe(true);
  });
  it.each(["inactive", "unlicensed", "incomplete-license", "no-role"])("does not infer internal audience from viewissue for %s", async (variant) => {
    const f = fixture(); if (variant === "inactive") f.person.active = false;
    if (variant === "unlicensed") f.person.applicationRoles = { size: 0, items: [] };
    if (variant === "incomplete-license") f.person.applicationRoles.size = 2;
    if (variant === "no-role") f.actors([]);
    await expect(f.validator.mention(f.c.accounts[0]!, ticket, "agent", "internal", undefined, credential, new AbortController().signal)).rejects.toMatchObject({ code: "MENTION_NOT_ALLOWED" });
  });
  it("proves group-backed membership by group ID, not a similar group name", async () => {
    const f = fixture(); f.actors([{ actorGroup: { name: "agents", groupId: "actual" } }]); f.groups([{ name: "agents", groupId: "other" }]);
    await expect(f.validator.mention(f.c.accounts[0]!, ticket, "agent", "internal", undefined, credential, new AbortController().signal)).rejects.toMatchObject({ code: "MENTION_NOT_ALLOWED" });
    f.groups([{ name: "different display", groupId: "actual" }]);
    await expect(f.validator.mention(f.c.accounts[0]!, ticket, "agent", "internal", undefined, credential, new AbortController().signal)).resolves.toMatchObject({ accountId: "agent" });
  });
  it("accepts a reporter as public audience but not as automatic internal evidence", async () => {
    const f = fixture(); f.person.accountId = "customer"; f.person.applicationRoles = { size: 0, items: [] };
    await expect(f.validator.mention(f.c.accounts[0]!, ticket, "customer", "public", undefined, credential, new AbortController().signal)).resolves.toMatchObject({ accountId: "customer" });
    await expect(f.validator.mention(f.c.accounts[0]!, ticket, "customer", "internal", undefined, credential, new AbortController().signal)).rejects.toMatchObject({ code: "MENTION_NOT_ALLOWED" });
  });
  it("does not grant public audience to another ticket viewer", async () => {
    const f = fixture();
    await expect(f.validator.mention(f.c.accounts[0]!, ticket, "agent", "public", undefined, credential, new AbortController().signal)).rejects.toMatchObject({ code: "MENTION_NOT_ALLOWED" });
  });
  it("checks explicit Platform role restrictions independently of issue access", async () => {
    const f = fixture(); f.roles([{ name: "Administrators", id: 10002 }]); f.actors([]);
    await expect(f.validator.mention(f.c.accounts[0]!, ticket, "agent", "ticket", { type: "role", value: "Administrators" }, credential, new AbortController().signal)).rejects.toMatchObject({ code: "MENTION_NOT_ALLOWED" });
  });
  it("does not reuse mention visibility as proof that a person is assignable", async () => {
    const f = fixture(); await f.validator.assignable(f.c.accounts[0]!, ticket.issueKey, "agent", credential, new AbortController().signal);
    await expect(f.validator.assignable(f.c.accounts[0]!, ticket.issueKey, "someone-else", credential, new AbortController().signal)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.read.mock.calls.every(([, path]) => path.includes("/assignable/") && path.includes("accountId="))).toBe(true);
  });
  it("keeps author authorization distinct from mention diagnostics", async () => {
    const f = fixture(); f.actors([]);
    await expect(f.validator.person(f.c.accounts[0]!, ticket, "agent", "internal", undefined, credential, new AbortController().signal)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(f.validator.mention(f.c.accounts[0]!, ticket, "agent", "internal", undefined, credential, new AbortController().signal)).rejects.toMatchObject({ code: "MENTION_NOT_ALLOWED" });
  });
  it.each([["NOT_FOUND_OR_NO_ACCESS", "MENTION_UNRESOLVED"], ["FORBIDDEN", "MENTION_NOT_ALLOWED"], ["CAPABILITY_NOT_SUPPORTED", "MENTION_NOT_SUPPORTED"]] as const)("maps %s only in mention resolution", async (code, expected) => {
    const f = fixture(); f.read.mockRejectedValue(new IssueKeeperError(code, "private-marker"));
    await expect(f.validator.mention(f.c.accounts[0]!, ticket, "agent", "ticket", undefined, credential, new AbortController().signal)).rejects.toMatchObject({ code: expected, retryable: false });
    try { await f.validator.mention(f.c.accounts[0]!, ticket, "agent", "ticket", undefined, credential, new AbortController().signal); } catch (error) { expect(String(error)).not.toContain("private-marker"); }
  });
  it("preserves authentication, infrastructure and native errors", async () => {
    const f = fixture();
    for (const error of [new IssueKeeperError("AUTH_FAILED", "safe"), new IssueKeeperError("INVALID_RESPONSE", "safe"), new Error("Native permission denied")]) {
      f.read.mockRejectedValue(error);
      await expect(f.validator.mention(f.c.accounts[0]!, ticket, "agent", "ticket", undefined, credential, new AbortController().signal)).rejects.toBe(error);
    }
  });
});
