import type { Plugin } from "@opencode/plugin";
import { vi } from "vitest";
import { registerReads } from "../src/tools/reads.js";
import type { Service } from "../src/core/service.js";
import { ResultSchema } from "../src/core/results.js";

type Context = Parameters<Plugin.Plugin["setup"]>[0];
type Editor = Parameters<Parameters<Context["tool"]["transform"]>[0]>[0];
type Tool = Parameters<Editor["add"]>[0];
type Execution = Parameters<Tool["execute"]>[1];

export async function toolHarness(service: Service) {
  const tools = new Map<string, Tool>();
  const assert = vi.fn(async (_: unknown) => {});
  const session = vi.fn(async () => ({ location: { directory: service.location } }));
  const ctx = {
    location: { directory: service.location }, options: service.config,
    permission: { assert }, session: { get: session },
    tool: { transform: async (callback: (editor: Editor) => void) => callback({
      list: () => [], get: () => undefined, update() {}, remove() {}, namespace() {},
      add(tool: Tool) { tools.set(tool.name, tool); },
    }) },
  } as unknown as Context;
  await registerReads(ctx, service);
  async function invoke(name: string, input: unknown, signal = new AbortController().signal, sessionID = "session-1") {
    const context = { sessionID, agent: "build", messageID: "message-1", id: "tool-1", signal, progress: async () => {} } as unknown as Execution;
    const result = await tools.get(name)!.execute(input, context);
    const parsed = JSON.parse(String(result.content));
    ResultSchema.parse(parsed);
    return parsed;
  }
  return { tools, invoke, assert, session, ctx };
}
