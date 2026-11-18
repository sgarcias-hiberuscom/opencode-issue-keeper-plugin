import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { IssueKeeperError } from "../../src/errors.js";

const state = vi.hoisted(() => ({ error: undefined as unknown }));
vi.mock("../../src/installer/index.js", () => ({
  install: async () => { throw state.error; },
  check: async () => 0,
  uninstall: async () => {},
}));
import { main, parseArguments } from "../../src/cli.js";

beforeEach(() => { state.error = undefined; });
describe("safe CLI diagnostics", () => {
  it("reports controlled configuration diagnostics", async () => {
    state.error = new IssueKeeperError("CONFIG_INVALID", "Configuración inválida en: http.timeoutMs.");
    const print = vi.fn();
    expect(await main(["install", "--global", "--source", "local"], { print, accept: async () => true })).toBe(1);
    expect(print).toHaveBeenCalledWith("Configuración inválida en: http.timeoutMs.");
  });
  it("does not expose raw validation keys or messages", async () => {
    const parsed = z.strictObject({}).safeParse({ PRIVATE_CREDENTIAL_MARKER: "private-value" });
    if (parsed.success) throw new Error("Expected invalid input");
    state.error = parsed.error;
    const print = vi.fn();
    expect(await main(["install", "--global", "--source", "local"], { print, accept: async () => true })).toBe(1);
    expect(JSON.stringify(print.mock.calls)).not.toContain("PRIVATE_CREDENTIAL_MARKER");
    expect(JSON.stringify(print.mock.calls)).not.toContain("private-value");
  });
});
describe("[6.9][cli] install source arguments", () => {
  it("falls back to the registry source for install without --source", () => {
    expect(parseArguments(["install", "--global"])).toEqual({ command: "install", source: "registry" });
  });
  it("still requires a value for --source when given", () => {
    expect(() => parseArguments(["install", "--global", "--source"])).toThrow();
  });
});
describe("[11.4][cli] global status arguments", () => {
  it("accepts status --global without a proposal", () => {
    expect(parseArguments(["status", "--global"])).toEqual({ command: "status", source: undefined });
  });
  it("rejects status without --global", () => {
    expect(() => parseArguments(["status"])).toThrow();
  });
  it("keeps status --global --proposal working", () => {
    expect(parseArguments(["status", "--global", "--proposal", "proposal-1"])).toEqual({ command: "status", source: undefined, proposalId: "proposal-1" });
  });
  it("still requires --proposal for review and verify", () => {
    expect(() => parseArguments(["review", "--global"])).toThrow();
    expect(() => parseArguments(["verify", "--global"])).toThrow();
  });
  it("explains an empty global status without creating state", async () => {
    const data = await mkdtemp("/tmp/opencode/jira-cli-status-");
    vi.stubEnv("XDG_DATA_HOME", dirname(data));
    try {
      const print = vi.fn();
      expect(await main(["status", "--global"], { print, accept: async () => true })).toBe(1);
      expect(print).toHaveBeenCalledWith("Todavía no hay ejecuciones registradas; el estado se crea al preparar la primera propuesta.");
      expect(existsSync(`${dirname(data)}/issuekeeper`)).toBe(false);
    } finally { vi.unstubAllEnvs(); await rm(data, { force: true, recursive: true }); }
  });
});
