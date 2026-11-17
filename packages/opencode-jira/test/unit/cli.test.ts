import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { IssueKeeperError } from "../../src/errors.js";

const state = vi.hoisted(() => ({ error: undefined as unknown }));
vi.mock("../../src/installer/index.js", () => ({
  install: async () => { throw state.error; },
  check: async () => 0,
  uninstall: async () => {},
}));
import { main } from "../../src/cli.js";

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
