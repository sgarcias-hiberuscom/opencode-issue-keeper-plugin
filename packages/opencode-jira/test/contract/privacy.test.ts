import { randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { m3Fixture } from "../m3-fixtures.js";
import { json } from "../helpers.js";
import { changeReview, reviewHTML } from "../../src/core/review.js";
import { inspectProposal } from "../../src/state/operator.js";

const SENTINEL = `ik-sentinel-${randomUUID()}`;
const EMAIL = "sentinel.person@example.invalid";
const TOOLS = ["accounts_list", "connection_test", "issues_search", "issue_get", "comments_list", "mention_candidates", "attachments_list", "attachment_download",
  "issue_edit_metadata", "transitions_list", "issue_update_prepare", "comment_prepare", "transition_prepare", "attachment_upload_prepare", "change_apply"];

function injectEmail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(injectEmail);
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => [key, injectEmail(item)]);
    return Object.fromEntries("accountId" in value ? [...entries, ["emailAddress", EMAIL]] : entries);
  }
  return value;
}

async function files(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

describe("[7.5][7.6][10.5] privacy sentinel across the tool surface", () => {
  let f: Awaited<ReturnType<typeof m3Fixture>>;
  const outputs: string[] = [];
  const logs: string[] = [];
  const results = new Map<string, Array<{ ok: boolean; error?: { code: string } }>>();
  const proposals: string[] = [];

  beforeAll(async () => {
    vi.stubEnv("IK_TEST_WORK", SENTINEL);
    const capture = (chunk: unknown) => { logs.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString()); return true; };
    vi.spyOn(process.stderr, "write").mockImplementation(capture as typeof process.stderr.write);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    f = await m3Fixture();
    f.c.http.readMaxAttempts = 1;
    f.files.set("101", { bytes: Buffer.from("hello"), filename: "example.txt" });
    f.remote.fields.attachment.push({ id: "101" });
    const base = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      const request = init ?? {};
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/rest/api/3/search/jql")) return json(injectEmail({ issues: [f.remote], isLast: true }));
      if (path.endsWith("/rest/servicedeskapi/servicedesk")) return json({ start: 0, limit: 1, size: 0, isLastPage: true, values: [] });
      if (/\/servicedeskapi\/request\/[A-Z]+-\d+\/comment$/.test(path)) {
        return json({ start: 0, limit: 25, size: 1, isLastPage: true, values: [{ id: "1", body: "Visible JSM", public: false, author: { accountId: "person", displayName: "Person" } }] });
      }
      if (/\/servicedeskapi\/request\/[A-Z]+-\d+\/attachment\/101$/.test(path)) return new Response("hello");
      if (/\/servicedeskapi\/request\/[A-Z]+-\d+\/attachment$/.test(path)) {
        return json({ start: 0, limit: 25, size: 1, isLastPage: true, values: [{ filename: "example.txt", size: 5, mimeType: "text/plain", _links: { jiraRest: `${f.c.accounts[0]!.siteUrl}/rest/api/3/attachment/101` } }] });
      }
      const response = await base(url, request);
      if (response.headers.get("content-type")?.includes("json")) return json(injectEmail(await response.json()), response.status);
      return response;
    });

    const call = async (name: string, input: unknown) => {
      const result = await f.harness.invoke(name, input);
      outputs.push(JSON.stringify(result));
      results.set(name, [...(results.get(name) ?? []), result]);
      return result;
    };
    const ref = { account: "work", issueKey: "IK-1" };
    await call("accounts_list", {});
    await call("connection_test", { account: "work" });
    await call("issues_search", { account: "work", jql: "project = IK" });
    await call("issue_get", { ...ref, fields: ["summary", "reporter", "description"] });
    await call("comments_list", ref);
    await call("mention_candidates", { ...ref, audience: "internal", accountId: "person" });
    await call("attachments_list", ref);
    await call("attachment_download", { ...ref, attachmentId: "101", destinationName: "example.bin" });
    await call("issue_edit_metadata", ref);
    await call("transitions_list", ref);

    for (const [tool, extra] of [
      ["comment_prepare", { audience: "ticket", text: "texto de prueba" }],
      ["issue_update_prepare", { update: { labels: [{ add: "privacy" }] } }],
      ["transition_prepare", { transitionId: "31" }],
    ] as const) {
      const plan = await f.prepare(tool, extra);
      proposals.push(plan.id);
      outputs.push(JSON.stringify(plan));
      const result = await call("change_apply", { proposalId: plan.id });
      expect(result.ok, JSON.stringify(result)).toBe(true);
    }
    const file = await f.source();
    const upload = await f.prepare("attachment_upload_prepare", { audience: "ticket", files: [file] });
    proposals.push(upload.id);
    outputs.push(JSON.stringify(upload));
    await call("change_apply", { proposalId: upload.id });

    for (const tool of TOOLS) await call(tool, { unexpected: SENTINEL });
  }, 60000);

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  });

  it("[7.5] exercises every one of the fifteen tools", () => {
    expect([...f.harness.tools.keys()].sort()).toEqual([...TOOLS].sort());
    for (const tool of TOOLS) expect(results.get(tool)?.length, tool).toBeGreaterThan(0);
    for (const tool of TOOLS) expect(results.get(tool)!.at(-1)!.ok, tool).toBe(false);
    for (const tool of ["accounts_list", "connection_test", "issues_search", "issue_get", "comments_list", "mention_candidates", "attachments_list", "attachment_download", "issue_edit_metadata", "transitions_list", "change_apply"]) {
      expect(results.get(tool)!.some((result) => result.ok), tool).toBe(true);
    }
  });

  it("[7.5] sent the sentinel to Jira, so the absence checks are meaningful", () => {
    const basic = `Basic ${Buffer.from(`${f.c.accounts[0]!.auth.email}:${SENTINEL}`).toString("base64")}`;
    const sent = f.fetcher.mock.calls.filter(([, init]) => (init?.headers as Record<string, string> | undefined)?.Authorization === basic);
    expect(sent.length).toBeGreaterThan(10);
  });

  it("[7.5] never discloses the token, its encodings or authorization headers in tool outputs and permission metadata", () => {
    const corpus = [...outputs, JSON.stringify(f.harness.assert.mock.calls)];
    const basic = Buffer.from(`${f.c.accounts[0]!.auth.email}:${SENTINEL}`).toString("base64");
    for (const forbidden of [SENTINEL, basic, "Basic ", "Authorization", Buffer.from(SENTINEL).toString("base64")]) {
      for (const text of corpus) expect(text).not.toContain(forbidden);
    }
  });

  it("[7.6] never writes the token or authorization headers to the diagnostic channel", () => {
    expect(logs.length).toBeGreaterThan(0);
    const joined = logs.join("\n");
    for (const forbidden of [SENTINEL, "Basic ", "Authorization", EMAIL]) expect(joined).not.toContain(forbidden);
  });

  it("[7.6] never exposes the fictional user email in outputs, permissions or logs", () => {
    const corpus = [...outputs, JSON.stringify(f.harness.assert.mock.calls), ...logs].join("\n");
    expect(corpus).not.toContain(EMAIL);
  });

  it("[7.6] keeps the token out of the state store, reviews and every local file", async () => {
    const basic = Buffer.from(`${f.c.accounts[0]!.auth.email}:${SENTINEL}`).toString("base64");
    const needles = [SENTINEL, basic, "Basic ", "Authorization", EMAIL].map((text) => Buffer.from(text));
    const listed = await files(f.root);
    expect(listed.some((path) => path.endsWith(".sqlite") || path.includes("issuekeeper"))).toBe(true);
    for (const path of listed) {
      const bytes = await readFile(path);
      for (const needle of needles) expect(bytes.includes(needle), `${path} contains ${needle.toString().slice(0, 8)}`).toBe(false);
    }
    for (const id of proposals) {
      const saved = await f.saved({ id } as never);
      const rendered = [reviewHTML(changeReview(saved.plan)), changeReview(saved.plan).text, JSON.stringify(await inspectProposal(id, f.data)), JSON.stringify(saved)].join("\n");
      for (const forbidden of [SENTINEL, "Basic ", "Authorization", EMAIL]) expect(rendered).not.toContain(forbidden);
    }
  });
});
