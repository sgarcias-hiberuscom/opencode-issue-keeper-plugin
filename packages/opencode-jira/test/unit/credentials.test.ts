import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, symlink, unlink, writeFile, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { authorization } from "../../src/credentials.js";
import { parseConfig } from "../../src/config.js";
import { config, rawAccount, createService } from "../helpers.js";
import { json, mockFetch, signal } from "../helpers.js";

afterEach(() => vi.unstubAllEnvs());
describe("credentials", () => {
  it("requires a nonempty secret and preserves variable token length", async () => {
    const account = config().accounts[0]!;
    for (const secret of [undefined, "", "   ", "x\ny"]) await expect(authorization(account, { IK_TEST_WORK: secret })).rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE" });
    const value = await authorization(account, { IK_TEST_WORK: "short\n" });
    expect(Buffer.from(value.slice(6), "base64").toString()).toBe("work@example.com:short");
  });
  it("rereads protected files for rotation and rejects permissive files/symlinks", async () => {
    const dir = await mkdtemp("/tmp/opencode/ik-credentials-");
    const file = join(dir, "token");
    const alias = join(dir, "alias");
    const account = parseConfig({ accounts: [{ ...rawAccount(), auth: { mode: "cloud-token", email: "work@example.com", tokenFile: file } }] }).accounts[0]!;
    try {
      await writeFile(file, "first\n", { mode: 0o600 });
      expect(await authorization(account)).toContain(Buffer.from("work@example.com:first").toString("base64"));
      await writeFile(file, "rotated");
      expect(await authorization(account)).toContain(Buffer.from("work@example.com:rotated").toString("base64"));
      await chmod(file, 0o644);
      await expect(authorization(account)).rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE" });
      await symlink(file, alias);
      account.auth.tokenFile = alias;
      await expect(authorization(account)).rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE" });
    } finally { await unlink(alias).catch(() => {}); await unlink(file); await rmdir(dir); }
  });
  it("isolates missing accounts and never serializes email or token sources", async () => {
    vi.stubEnv("IK_TEST_WORK", "private-secret");
    vi.stubEnv("IK_TEST_CLIENT", "");
    const service = await createService(config(), process.cwd());
    try {
      const result = await service.accounts();
      expect(result.map((a) => a.state)).toEqual(["unchecked", "unavailable"]);
      const serialized = JSON.stringify(result);
      for (const secret of ["private-secret", "tokenEnv", "work@example.com", "IK_TEST_WORK", "Authorization"]) expect(serialized).not.toContain(secret);
    } finally { service.close(); }
  });
  it("[4.6][E01][CFG-10] explicitly rejects tokenFile on Windows", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    const account = parseConfig({ accounts: [{ ...rawAccount(), auth: { mode: "cloud-token", email: "work@example.com", tokenFile: "/not-read" } }] }).accounts[0]!;
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      await expect(authorization(account)).rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE" });
    } finally { Object.defineProperty(process, "platform", descriptor); }
  });
  it("[4.6][E01][AC-04] recovers after a 401 and file rotation without replacing the service", async () => {
    const dir = await mkdtemp("/tmp/opencode/ik-rotation-");
    const token = join(dir, "token");
    await writeFile(token, "expired", { mode: 0o600 });
    const c = parseConfig({ accounts: [{ ...rawAccount(), auth: { mode: "cloud-token", email: "work@example.com", tokenFile: token } }] });
    const service = await createService(c, process.cwd(), mockFetch((_, init) => {
      const auth = (init.headers as Record<string, string>).Authorization!;
      return Buffer.from(auth.slice(6), "base64").toString().endsWith(":rotated") ? json({ accountId: "known" }) : json({}, 401);
    }));
    try {
      await expect(service.connection("work", signal())).rejects.toMatchObject({ code: "AUTH_FAILED" });
      await writeFile(token, "rotated");
      expect((await service.connection("work", signal())).identity.id).toBe("known");
      expect((await service.accounts())[0]?.state).toBe("available");
    } finally { service.close(); await unlink(token); await rmdir(dir); }
  });
});
