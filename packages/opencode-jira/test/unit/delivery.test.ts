import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { stateCompatibility } from "../../src/state/store.js";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("[M4][PKG-01][TST-03][EN-01][OP-05] independent and offline delivery", () => {
  it("keeps release, lock, formats and distribution allowlist coherent", async () => {
    const pkg = JSON.parse(await read("../../package.json")); const lock = JSON.parse(await read("../../package-lock.json"));
    expect(pkg.version).toBe(lock.version); expect(pkg.version).toBe(lock.packages[""].version);
    expect(pkg.dependencies).toEqual(lock.packages[""].dependencies); expect(pkg.issuekeeperState).toEqual(stateCompatibility);
    expect(pkg.private).toBe(true); expect(pkg.files).toEqual(["dist", "templates", "README.md", "options.schema.json", "opencode.example.jsonc"]);
    for (const script of ["preinstall", "install", "postinstall"]) expect(pkg.scripts[script]).toBeUndefined();
  });
  it("never selects live suites from default/offline commands and scopes inherited live to reads", async () => {
    const { scripts } = JSON.parse(await read("../../package.json"));
    expect(scripts.test).toBe("npm run test:mock"); expect(scripts["test:mock"]).toMatch(/^vitest run test\/unit test\/contract test\/installer /);
    expect(scripts["test:live"]).toBe("npm run test:live:read");
    expect(scripts["test:live:read"]).toContain("test/integration/inventory-read.test.ts "); expect(scripts["test:live:read"]).toContain("reports/live-read/results.json");
    expect(scripts["test:live:write"]).toBeUndefined();
  });
  it("keeps CI secrets behind manual non-fork protected read integration and uploads only selected reports", async () => {
    const workflow = await read("../../../../.github/workflows/jira-read.yml");
    const offline = workflow.slice(0, workflow.indexOf("  live-read:")); const live = workflow.slice(workflow.indexOf("  live-read:"));
    expect(offline).not.toContain("secrets."); expect(offline).toContain("node: [22, 24]");
    expect(offline).toContain("npm run test:mock"); expect(offline).toContain("npm run test:pack");
    expect(live).toContain("github.event_name == 'workflow_dispatch' && inputs.live && github.event.repository.fork == false");
    expect(live).toContain("environment: jira-integration"); expect(live).toContain("npm run test:live:read");
    expect(workflow).not.toMatch(/ISSUEKEEPER_LIVE_WRITES|JIRA_WRITE|test:live:write|reports\/phase2/);
    expect([...workflow.matchAll(/^          path: (.+)/gm)].map((match) => match[1])).toEqual(["packages/opencode-jira/reports/mock/", "packages/opencode-jira/reports/live-read/"]);
  });
});
