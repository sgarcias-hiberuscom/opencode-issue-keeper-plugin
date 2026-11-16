import { readFile } from "node:fs/promises";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
import { parseConfig } from "../../src/config.js";
import { Service } from "../../src/core/service.js";
import { JiraCloud } from "../../src/jira/cloud.js";
import { HttpClient } from "../../src/http.js";
import { toolHarness } from "../harness.js";

const live = process.env.ISSUEKEEPER_LIVE_READS === "1" && Boolean(process.env.ISSUEKEEPER_LIVE_FIXTURE);
let service: Service | undefined;
afterAll(() => service?.close());

it.skipIf(!live)("reads two real JSM identities and checks a known internal comment/attachment", async () => {
  const path = process.env.ISSUEKEEPER_LIVE_CONFIG;
  if (!path) throw new Error("ISSUEKEEPER_LIVE_CONFIG debe apuntar a un JSON de opciones fuera del repositorio.");
  const fixture = z.strictObject({
    agent: z.string(), customer: z.string(), issueKey: z.string(), internalCommentId: z.string(), internalAttachmentId: z.string(), publicCommentId: z.string(), publicAttachmentId: z.string(),
  }).parse(JSON.parse(process.env.ISSUEKEEPER_LIVE_FIXTURE ?? "{}"));
  expect(fixture.agent).not.toBe(fixture.customer);
  const config = parseConfig(JSON.parse(await readFile(path, "utf8")));
  service = await Service.create(config, process.cwd(), new JiraCloud(config, new HttpClient(config)));
  const h = await toolHarness(service);
  const controller = new AbortController();
  for (const id of [fixture.agent, fixture.customer]) {
    const account = service.account(id);
    expect(account.serviceManagement.enabled).toBe(true);
    const ticket = await h.invoke("issue_get", { account: id, issueKey: fixture.issueKey }, controller.signal);
    expect(ticket.ok === true && Boolean(ticket.data.serviceRequest)).toBe(true);
    const commentIds: string[] = [];
    let cursor: string | undefined;
    let last = false;
    for (let page = 0; page < 20; page++) {
      const result = await h.invoke("comments_list", { account: id, issueKey: fixture.issueKey, maxResults: 100, cursor }, controller.signal);
      expect(result.ok === true).toBe(true);
      commentIds.push(...result.data.values.map((v: { id: string }) => v.id));
      cursor = result.data.cursor; last = result.data.isLast;
      if (last) break;
    }
    expect(last).toBe(true);
    expect(commentIds).toContain(fixture.publicCommentId);
    expect(commentIds.includes(fixture.internalCommentId)).toBe(id === fixture.agent);
    const attachmentIds: string[] = [];
    cursor = undefined; last = false;
    for (let page = 0; page < 20; page++) {
      const result = await h.invoke("attachments_list", { account: id, issueKey: fixture.issueKey, maxResults: 100, cursor }, controller.signal);
      expect(result.ok === true).toBe(true);
      attachmentIds.push(...result.data.values.map((v: { id: string }) => v.id));
      cursor = result.data.cursor; last = result.data.isLast;
      if (last) break;
    }
    expect(last).toBe(true);
    expect(attachmentIds).toContain(fixture.publicAttachmentId);
    expect(attachmentIds.includes(fixture.internalAttachmentId)).toBe(id === fixture.agent);
  }
}, 120000);
