import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/http.js";
import { captureCredential, boundAuthorization } from "../../src/credentials.js";
import { mutationRequest, MutationUncertainError, type JiraMutation } from "../../src/jira/mutations.js";
import { config, json, mockFetch, signal } from "../helpers.js";

describe("[M5][CM-09] canonical visibility wire representation", () => {
  it.each(["role", "group"] as const)("sends only the pinned %s identifier while retaining its reviewed name", (type) => {
    const body = { type: "doc" as const, version: 1 as const, content: [{ type: "paragraph", content: [{ type: "text", text: "private" }] }] };
    const visibility = { type, value: "Reviewed name", identifier: type === "group" ? "stable-group-id" : "Reviewed role" };
    const request = { kind: "platform-comment" as const, issueKey: "IK-1", body, visibility };
    expect(JSON.parse(mutationRequest(request).body)).toEqual({ body, visibility: { type, identifier: visibility.identifier } });
    expect(request.visibility).toEqual(visibility);
    expect(JSON.parse(mutationRequest({ ...request, visibility: { type, value: "Legacy name" } }).body).visibility).toEqual({ type, value: "Legacy name" });
  });
});

beforeEach(() => vi.stubEnv("IK_TEST_WORK", "private-secret"));
afterEach(() => vi.unstubAllEnvs());
const change: JiraMutation = { kind: "fields", issueKey: "IK-1", fields: { summary: "nuevo" } };
async function fixture(response: () => Response | Promise<Response> = () => new Response(null, { status: 204 })) {
  const c = config(); c.accounts[0]!.readOnly = false;
  const account = c.accounts[0]!;
  const lease = await captureCredential(account, async () => "identity");
  const fetcher = mockFetch(response); const http = new HttpClient(c, fetcher);
  return { c, account, lease, fetcher, http };
}
describe("[HTTP-01/02][IDN-01][RC-01–RC-04] typed single-attempt mutations", () => {
  it.each([400, 401, 403, 404, 409, 413, 415, 422, 429])("does not retry a definitive HTTP %i rejection", async (status) => {
    const f = await fixture(() => json({ secret: "private-secret" }, status)); const journal = vi.fn(async () => {});
    await expect(f.http.mutate(f.account, change, f.lease, signal(), journal)).resolves.toEqual({ outcome: "rejected", status });
    expect(f.fetcher).toHaveBeenCalledTimes(1); expect(journal).toHaveBeenCalledTimes(1); f.http.close();
  });
  it.each([301, 302, 307, 308, 500, 502, 503, 504, 200])("keeps HTTP %i uncertain without retry or redirect", async (status) => {
    const f = await fixture(() => json({}, status));
    await expect(f.http.mutate(f.account, change, f.lease, signal(), async () => {})).rejects.toBeInstanceOf(MutationUncertainError);
    expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.fetcher.mock.calls[0]![1]!.redirect).toBe("manual"); f.http.close();
  });
  it("only sends after the durable callback and shares a bound credential with validation", async () => {
    const f = await fixture(); let persisted = false;
    f.fetcher.mockImplementation(async (_, init) => { expect(persisted).toBe(true); expect(init?.method).toBe("PUT"); expect(init?.body).toBe('{"fields":{"summary":"nuevo"}}'); return new Response(null, { status: 204 }); });
    await expect(f.http.mutate(f.account, change, f.lease, signal(), async () => { persisted = true; })).resolves.toMatchObject({ outcome: "confirmed", status: 204 });
    f.http.close();
  });
  it("does not send if the durable callback fails", async () => {
    const f = await fixture(); const original = new Error("disk failure");
    await expect(f.http.mutate(f.account, change, f.lease, signal(), async () => { throw original; })).rejects.toBe(original);
    expect(f.fetcher).not.toHaveBeenCalled(); f.http.close();
  });
  it.each(["before", "during-journal"])("detects credential rotation %s validation/send", async (when) => {
    const f = await fixture();
    if (when === "before") vi.stubEnv("IK_TEST_WORK", "rotated");
    await expect(f.http.mutate(f.account, change, f.lease, signal(), async () => { vi.stubEnv("IK_TEST_WORK", "rotated"); })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.fetcher).not.toHaveBeenCalled(); f.http.close();
  });
  it("does not expose credentials through lease serialization and rejects a forged lease", async () => {
    const f = await fixture(); expect(JSON.stringify(f.lease)).not.toContain("private-secret"); expect(JSON.stringify(f.lease)).not.toContain("Basic");
    await expect(boundAuthorization({ ...f.lease }, f.account)).rejects.toMatchObject({ code: "CONFLICT" });
    f.http.close();
  });
  it("accepts a newly validated rotated token of the same stable identity", async () => {
    const f = await fixture(); vi.stubEnv("IK_TEST_WORK", "rotated");
    const lease = await captureCredential(f.account, async () => "identity"); expect(lease.identity).toBe(f.lease.identity);
    await expect(f.http.mutate(f.account, change, lease, signal(), async () => {})).resolves.toMatchObject({ outcome: "confirmed" }); f.http.close();
  });
  it("does not retry fetch failure or malformed/excessive accepted responses", async () => {
    for (const response of [() => { throw new Error("private-secret"); }, () => new Response("broken", { status: 201, headers: { "content-type": "application/json" } }), () => json({ text: "a".repeat(200) }, 201)]) {
      const f = await fixture(response); f.c.http.maxResponseBytes = 100;
      await expect(f.http.mutate(f.account, { kind: "jsm-comment", issueKey: "IK-1", body: "hola", public: false }, f.lease, signal(), async () => {})).rejects.toBeInstanceOf(MutationUncertainError);
      expect(f.fetcher).toHaveBeenCalledTimes(1); f.http.close();
    }
  });
  it("preserves cancellation before sending and classifies cancellation after dispatch", async () => {
    const f = await fixture(); const abort = new AbortController(); const original = new Error("native stop"); abort.abort(original);
    await expect(f.http.mutate(f.account, change, f.lease, abort.signal, async () => {})).rejects.toBe(original); expect(f.fetcher).not.toHaveBeenCalled();
    const after = new AbortController(); f.fetcher.mockImplementation(async () => { after.abort(original); throw original; });
    await expect(f.http.mutate(f.account, change, f.lease, after.signal, async () => {})).rejects.toMatchObject({ reason: "cancelled", cancellation: original });
    f.http.close();
  });
  it("binds /myself validation to the exact credential used for its HTTP request", async () => {
    const c = config(); const fetcher = mockFetch((_, init) => { expect((init.headers as Record<string, string>).Authorization).toContain("Basic "); return json({ accountId: "stable", active: true }); });
    const http = new HttpClient(c, fetcher); const lease = await http.identityForWrite(c.accounts[0]!, signal());
    expect(lease.identity).toBe("stable"); expect(fetcher).toHaveBeenCalledTimes(1); http.close();
  });
  it.each([
    { ...change, path: "https://evil.invalid" }, { ...change, kind: "delete" }, { ...change, issueKey: "IK-1/../other" },
    { ...change, fields: { comment: "hidden" } }, { ...change, fields: { status: "done" } }, { ...change, fields: {} },
    { ...change, update: { summary: [{ set: "duplicate" }] } },
  ])("rejects a manipulated operation before credentials or network %#", async (request) => {
    const f = await fixture(); await expect(f.http.mutate(f.account, request as JiraMutation, f.lease, signal(), async () => {})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(f.fetcher).not.toHaveBeenCalled(); f.http.close();
  });
  it("builds exact transitions and explicit JSM audiences without extra parameters", () => {
    expect(mutationRequest({ kind: "transition", issueKey: "IK-1", transitionId: "31" })).toMatchObject({ method: "POST", path: "rest/api/3/issue/IK-1/transitions", body: '{"transition":{"id":"31"}}' });
    expect(JSON.parse(mutationRequest({ kind: "jsm-comment", issueKey: "IK-1", body: "nota", public: false }).body)).toEqual({ body: "nota", public: false });
  });
  it("revalidates inside a reserved HTTP slot at limit one without deadlock or concurrent nested reads", async () => {
    const f = await fixture(); f.c.http.maxConcurrentPerAccount = 1; let active = 0; let peak = 0;
    f.fetcher.mockImplementation(async (_url, init) => {
      active++; peak = Math.max(peak, active); await Promise.resolve(); active--;
      return init?.method === "PUT" ? new Response(null, { status: 204 }) : json({ valid: true });
    });
    await expect(f.http.mutate(f.account, change, f.lease, signal(), async () => {
      await Promise.all([f.http.json(f.account, "rest/api/3/myself", signal()), f.http.json(f.account, "rest/api/3/myself", signal())]);
    })).resolves.toMatchObject({ outcome: "confirmed" });
    expect(peak).toBe(1); expect(f.fetcher).toHaveBeenCalledTimes(3); f.http.close();
  });
  it("refuses a nested mutation in the pre-send validation callback", async () => {
    const f = await fixture(); f.c.http.maxConcurrentPerAccount = 1;
    await expect(f.http.mutate(f.account, change, f.lease, signal(), async () => {
      await expect(f.http.mutate(f.account, change, f.lease, signal(), async () => {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    })).resolves.toMatchObject({ outcome: "confirmed" });
    expect(f.fetcher).toHaveBeenCalledTimes(1); f.http.close();
  });
});
