import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = await mkdtemp("/tmp/opencode/issuekeeper-checkout-");
try {
  const project = join(scratch, "checkout");
  const pkg = join(project, "packages/opencode-jira");
  const excluded = new Set(["node_modules", "dist", "reports", "coverage", ".ruff_cache"]);
  await cp(join(root, "packages/opencode-jira"), pkg, { recursive: true, filter: (path) => !excluded.has(basename(path)) && !/\.(?:tgz|tsbuildinfo)$/.test(path) });
  await cp(join(root, ".opencode/commands"), join(project, ".opencode/commands"), { recursive: true });
  await mkdir(join(project, ".github/workflows"), { recursive: true });
  await cp(join(root, ".github/workflows/jira-read.yml"), join(project, ".github/workflows/jira-read.yml"));
  const cache = execFileSync("npm", ["config", "get", "cache"], { encoding: "utf8", timeout: 10000 }).trim();
  const env = { PATH: process.env.PATH, HOME: join(scratch, "home"), XDG_CONFIG_HOME: join(scratch, "config"), XDG_DATA_HOME: join(scratch, "data"), npm_config_cache: cache, npm_config_update_notifier: "false" };
  const run = (args) => execFileSync("npm", args, { cwd: pkg, env, stdio: "pipe", timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  run(["ci", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"]);
  run(["run", "typecheck"]); run(["run", "test:mock"]); run(["run", "build"]);
  const report = JSON.parse(await readFile(join(pkg, "reports/mock/results.json"), "utf8"));
  assert.equal(report.success, true); assert.equal(report.numFailedTests, 0);
  const skipped = report.testResults.flatMap((suite) => suite.assertionResults.filter((test) => test.status === "pending" || test.status === "skipped").map((test) => ({ file: suite.name, name: test.fullName })));
  assert.equal(skipped.length, 7);
  assert(skipped.every((test) => test.file.endsWith("/test/unit/documents.test.ts")));
  console.log(JSON.stringify({ node: process.version, sourceOnly: true, passed: report.numPassedTests, skippedOptionalSpecification: skipped.length, failed: report.numFailedTests, typecheck: true, build: true }));
} catch (error) {
  if (error.stdout) console.error(String(error.stdout));
  if (error.stderr) console.error(String(error.stderr));
  throw error;
} finally { await rm(scratch, { recursive: true, force: true }); }
