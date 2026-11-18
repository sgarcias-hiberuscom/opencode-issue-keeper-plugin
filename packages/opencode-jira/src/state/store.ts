import Database from "better-sqlite3";
import { existsSync, lstatSync, readdirSync, statfsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isMainThread } from "node:worker_threads";
import {
  canonicalJSON, ExecutionSchema, LocalId, PinnedFileSchema, planHash, Sha256, StepReceiptSchema, Timestamp, validatePlan,
  type ChangeExecution, type ChangePlan, type StepReceipt, type StoredChange, type PinnedFile,
} from "../core/proposals.js";
import { operations } from "../core/operation.js";
import { assertPrivateFile, checkSidecars, ensurePrivateFile, privateDirectory, syncDirectory, verifyPinnedFile } from "./files.js";
import { StateError } from "./errors.js";
import { statePaths, type StatePaths } from "./paths.js";

export const stateCompatibility = Object.freeze({ database: 1, plan: 1 });
export const statePolicy = Object.freeze({
  databaseBytes: 256 * 1024 * 1024, reserveBytes: 16 * 1024 * 1024, stagingBytes: 512 * 1024 * 1024,
  terminalMs: 7 * 86400_000, expiredMs: 86400_000,
});
type Scalar = string | number | null;
type Row = Record<string, Scalar>;
type Limits = typeof statePolicy;
export interface StoreOptions {
  mode?: "runtime" | "maintenance";
  now?: () => Date;
  limits?: Partial<{ [K in keyof Limits]: number }>;
  fault?: (point: "before-commit" | "after-retention-commit") => void;
}
const registryKey = Symbol.for("issuekeeper.jira.sqlite-owners.v1");
function owners(): Set<string> {
  const global = globalThis as typeof globalThis & { [key: symbol]: unknown };
  if (global[registryKey] === undefined) global[registryKey] = new Set<string>();
  if (!(global[registryKey] instanceof Set)) throw new StateError("INCOMPATIBLE");
  return global[registryKey] as Set<string>;
}

export class ChangeStore {
  private readonly ownedStaging = new Map<string, { dev: number; ino: number }>();
  readonly paths: StatePaths;
  private owner: Database.Database | undefined;
  private db: Database.Database | undefined;
  private ownerKey: string | undefined;
  private readonly options: StoreOptions;
  private readonly limits: { [K in keyof Limits]: number };
  private stagingReserved = 0;
  private stagingLeases = 0;

  constructor(data: string, options: StoreOptions = {}) {
    this.paths = statePaths(data);
    this.options = options;
    this.limits = { ...statePolicy, ...options.limits };
    if (process.platform !== "linux" || !isMainThread) throw new StateError("UNSUPPORTED");
    if (Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value < 0)
      || this.limits.databaseBytes < 65536 || this.limits.reserveBytes >= this.limits.databaseBytes) throw new StateError("INVALID");
    try {
      privateDirectory(data);
      privateDirectory(this.paths.directory);
      if ([0x6969, 0x517b, 0xff534d42, 0x5346414f, 0x73757245, 0xc36400].includes(Number(statfsSync(this.paths.directory).type))) throw new StateError("UNSUPPORTED");
      const stat = lstatSync(this.paths.directory);
      const key = `${stat.dev}:${stat.ino}`;
      if (owners().has(key)) throw new StateError("BUSY");
      owners().add(key); this.ownerKey = key;
      ensurePrivateFile(this.paths.owner); checkSidecars(this.paths.owner);
      this.owner = new Database(this.paths.owner, { fileMustExist: true, timeout: 0 });
      try { this.owner.exec("BEGIN EXCLUSIVE"); }
      catch (error) {
        if ((error as { code?: string }).code?.startsWith("SQLITE_BUSY")) throw new StateError("BUSY");
        throw error;
      }
      privateDirectory(this.paths.staging);
      const created = ensurePrivateFile(this.paths.database); checkSidecars(this.paths.database);
      this.db = new Database(this.paths.database, { fileMustExist: true, timeout: 0 });
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY");
      if (created) this.initialize();
      this.validate();
      const pageSize = Number(this.one("PRAGMA page_size")!.page_size);
      this.db.pragma(`max_page_count=${Math.floor(this.limits.databaseBytes / pageSize)}`);
      if (created) { syncDirectory(this.paths.directory); syncDirectory(join(this.paths.directory, "..")); }
      if (options.mode !== "maintenance") this.recover();
    } catch (error) {
      this.close();
      if (error instanceof StateError) throw error;
      throw new StateError("CORRUPT");
    }
  }

  private database(): Database.Database {
    if (!this.db) throw new StateError("CLOSED");
    return this.db;
  }
  private one(sql: string, ...values: Scalar[]): Row | undefined { return this.database().prepare<Scalar[], Row>(sql).get(...values); }
  private all(sql: string, ...values: Scalar[]): Row[] { return this.database().prepare<Scalar[], Row>(sql).all(...values); }
  private run(sql: string, ...values: Scalar[]): Database.RunResult { return this.database().prepare(sql).run(...values); }
  private transaction<T>(callback: () => T): T {
    const db = this.database();
    try {
      db.exec("BEGIN IMMEDIATE");
      const result = callback();
      this.options.fault?.("before-commit");
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { if (db.inTransaction) db.exec("ROLLBACK"); } catch { this.close(); }
      if (error instanceof StateError) throw error;
      throw new StateError("IO");
    }
  }
  private initialize(): void {
    this.transaction(() => this.database().exec(`
      PRAGMA application_id=${0x494b4a32}; PRAGMA user_version=1;
      CREATE TABLE plans (id TEXT PRIMARY KEY, hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, document TEXT NOT NULL) STRICT;
      CREATE TABLE executions (id TEXT PRIMARY KEY REFERENCES plans(id) ON DELETE CASCADE, revision INTEGER NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL, document TEXT NOT NULL) STRICT;
      CREATE TABLE receipts (proposal TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, step TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(proposal, step)) STRICT;
      CREATE TABLE claims (site TEXT NOT NULL, issue TEXT NOT NULL, proposal TEXT UNIQUE NOT NULL REFERENCES plans(id), PRIMARY KEY(site, issue)) STRICT;
      CREATE TABLE files (ref TEXT PRIMARY KEY, proposal TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, size INTEGER NOT NULL, hash TEXT NOT NULL) STRICT;
      CREATE TABLE staging_gc (ref TEXT PRIMARY KEY, size INTEGER NOT NULL, hash TEXT NOT NULL) STRICT;
      CREATE TABLE events (sequence INTEGER PRIMARY KEY, proposal TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, revision INTEGER NOT NULL, event TEXT NOT NULL, at TEXT NOT NULL, request_id TEXT NOT NULL) STRICT;
      CREATE INDEX execution_state ON executions(state, updated_at);
    `));
  }

  private validate(): void {
    if (this.one("PRAGMA application_id")?.application_id !== 0x494b4a32 || this.one("PRAGMA user_version")?.user_version !== 1) throw new StateError("INCOMPATIBLE");
    if (this.one("PRAGMA journal_mode")?.journal_mode !== "delete") throw new StateError("INCOMPATIBLE");
    if (this.one("PRAGMA integrity_check")?.integrity_check !== "ok" || this.all("PRAGMA foreign_key_check").length) throw new StateError("CORRUPT");
    const tables = this.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((row) => row.name);
    if (canonicalJSON(tables) !== canonicalJSON(["claims", "events", "executions", "files", "plans", "receipts", "staging_gc"])) throw new StateError("CORRUPT");
    for (const row of this.all("SELECT id FROM plans")) {
      const snapshot = this.get(String(row.id));
      const claim = this.one("SELECT site, issue FROM claims WHERE proposal=?", snapshot.plan.id);
      const claimed = ["applying", "unknown"].includes(snapshot.execution.state)
        || snapshot.execution.state === "failed" && snapshot.execution.steps.some((step) => step.state === "confirmed");
      if (claimed !== Boolean(claim) || claim && (claim.site !== snapshot.plan.site || claim.issue !== snapshot.plan.issueId)) throw new StateError("CORRUPT");
    }
    for (const row of this.all("SELECT ref, size, hash FROM staging_gc")) {
      if (!LocalId.safeParse(row.ref).success || !Sha256.safeParse(row.hash).success || !Number.isSafeInteger(row.size) || Number(row.size) < 0 || Number(row.size) > 100 * 1024 * 1024 || this.one("SELECT ref FROM files WHERE ref=?", row.ref!)) throw new StateError("CORRUPT");
    }
  }

  get(proposalId: string): StoredChange {
    const row = this.one("SELECT p.document AS plan, p.hash, p.created_at, p.expires_at, e.document AS execution, e.revision, e.state, e.updated_at FROM plans p LEFT JOIN executions e ON p.id=e.id WHERE p.id=?", proposalId);
    if (!row) throw new StateError("NOT_FOUND");
    try {
      const rawPlan = JSON.parse(String(row.plan));
      if (typeof rawPlan?.version === "number" && rawPlan.version !== stateCompatibility.plan) throw new StateError("INCOMPATIBLE");
      const plan = validatePlan(rawPlan);
      const execution = ExecutionSchema.parse(JSON.parse(String(row.execution)));
      if (plan.id !== proposalId || planHash(plan) !== row.hash || plan.createdAt !== row.created_at || plan.expiresAt !== row.expires_at || execution.payloadHash !== row.hash || execution.proposalId !== proposalId
        || execution.revision !== row.revision || execution.state !== row.state || execution.updatedAt !== row.updated_at
        || canonicalJSON(execution.steps.map((step) => step.id)) !== canonicalJSON(plan.steps.map((step) => step.id))) throw new StateError("CORRUPT");
      const receipts: Record<string, StepReceipt> = Object.create(null);
      for (const record of this.all("SELECT step, document FROM receipts WHERE proposal=?", proposalId)) {
        if (!execution.steps.some((step) => step.id === record.step && step.state === "confirmed")) throw new StateError("CORRUPT");
        receipts[String(record.step)] = StepReceiptSchema.parse(JSON.parse(String(record.document)));
      }
      if (execution.steps.some((step) => (step.state === "confirmed") !== Boolean(receipts[step.id]))) throw new StateError("CORRUPT");
      if (execution.state === "prepared" && execution.steps.some((step) => step.state !== "pending")) throw new StateError("CORRUPT");
      if (execution.state === "applied" && execution.steps.some((step) => !receipts[step.id]?.verifiedAt)) throw new StateError("CORRUPT");
      if (execution.state === "failed" && execution.steps.some((step) => ["sending", "unknown"].includes(step.state))) throw new StateError("CORRUPT");
      const files = this.all("SELECT ref, size, hash FROM files WHERE proposal=? ORDER BY ref", proposalId);
      if (canonicalJSON(files) !== canonicalJSON([...plan.files].sort((a, b) => a.stagedRef < b.stagedRef ? -1 : a.stagedRef > b.stagedRef ? 1 : 0).map((file) => ({ ref: file.stagedRef, size: file.size, hash: file.sha256 })))) throw new StateError("CORRUPT");
      return { plan, payloadHash: String(row.hash), execution, receipts };
    } catch (error) {
      if (error instanceof StateError && error.reason === "INCOMPATIBLE") throw error;
      throw new StateError("CORRUPT");
    }
  }
  registerStagedFile(ref: string, inode: { dev: number; ino: number }): void {
    if (!LocalId.safeParse(ref).success || !Number.isSafeInteger(inode.dev) || !Number.isSafeInteger(inode.ino)) throw new StateError("INVALID");
    this.ownedStaging.set(ref, { dev: inode.dev, ino: inode.ino });
  }
  discardUnassociated(files: readonly PinnedFile[]): void {
    if (!Array.isArray(files) || files.length > 20 || files.some((file) => !PinnedFileSchema.safeParse(file).success)) throw new StateError("INVALID");
    for (const file of files) {
      const owned = this.ownedStaging.get(file.stagedRef);
      if (!owned) continue;
      if (this.one("SELECT ref FROM files WHERE ref=?", file.stagedRef) || this.one("SELECT ref FROM staging_gc WHERE ref=?", file.stagedRef)) continue;
      const path = join(this.paths.staging, file.stagedRef);
      verifyPinnedFile(path, file);
      const current = lstatSync(path);
      if (current.dev !== owned.dev || current.ino !== owned.ino) continue;
      unlinkSync(path);
      this.ownedStaging.delete(file.stagedRef);
    }
    syncDirectory(this.paths.staging);
  }

  private at(value?: string): string {
    const at = value ?? (this.options.now?.() ?? new Date()).toISOString();
    if (!Timestamp.safeParse(at).success) throw new StateError("INVALID");
    return at;
  }
  private event(execution: ChangeExecution, event: string): void {
    this.run("INSERT INTO events(proposal, revision, event, at, request_id) VALUES(?,?,?,?,?)", execution.proposalId, execution.revision, event, execution.updatedAt, operations.getStore()?.requestId ?? `local-${randomUUID()}`);
  }
  prepare(input: ChangePlan): StoredChange {
    let plan: ChangePlan;
    try { plan = validatePlan(input); } catch { throw new StateError("INVALID"); }
    if (this.one("SELECT id FROM plans WHERE id=?", plan.id)) throw new StateError("CONFLICT");
    for (const file of plan.files) {
      if (this.one("SELECT ref FROM files WHERE ref=?", file.stagedRef) || this.one("SELECT ref FROM staging_gc WHERE ref=?", file.stagedRef)) throw new StateError("CONFLICT");
      verifyPinnedFile(join(this.paths.staging, file.stagedRef), file);
    }
    const at = this.at();
    if (Date.parse(at) < Date.parse(plan.createdAt) || Date.parse(at) >= Date.parse(plan.expiresAt)) throw new StateError("EXPIRED");
    const payloadHash = planHash(plan);
    const execution: ChangeExecution = { proposalId: plan.id, payloadHash, state: "prepared", revision: 0, updatedAt: at, steps: plan.steps.map((step) => ({ id: step.id, state: "pending" })) };
    this.collect(at, Buffer.byteLength(canonicalJSON(plan)) + 65536);
    this.transaction(() => {
      this.run("INSERT INTO plans VALUES(?,?,?,?,?)", plan.id, payloadHash, plan.createdAt, plan.expiresAt, canonicalJSON(plan));
      this.run("INSERT INTO executions VALUES(?,?,?,?,?)", plan.id, 0, "prepared", at, canonicalJSON(execution));
      for (const file of plan.files) this.run("INSERT INTO files VALUES(?,?,?,?)", file.stagedRef, plan.id, file.size, file.sha256);
      this.event(execution, "prepared");
    });
    return this.get(plan.id);
  }

  private update(proposalId: string, revision: number, event: string, change: (snapshot: StoredChange) => void, value?: string): StoredChange {
    const at = this.at(value);
    this.transaction(() => {
      const snapshot = this.get(proposalId);
      if (snapshot.execution.revision !== revision) throw new StateError("CONFLICT");
      change(snapshot);
      snapshot.execution.revision++;
      snapshot.execution.updatedAt = at;
      const result = this.run("UPDATE executions SET document=?, revision=?, state=?, updated_at=? WHERE id=? AND revision=?", canonicalJSON(snapshot.execution), snapshot.execution.revision, snapshot.execution.state, at, proposalId, revision);
      if (result.changes !== 1) throw new StateError("CONFLICT");
      this.event(snapshot.execution, event);
    });
    return this.get(proposalId);
  }
  claim(proposalId: string, revision: number, value?: string): StoredChange {
    const at = this.at(value);
    return this.update(proposalId, revision, "claimed", ({ plan, execution }) => {
      if (execution.state !== "prepared") throw new StateError("CONFLICT");
      if (Date.parse(at) < Date.parse(plan.createdAt) || Date.parse(at) >= Date.parse(plan.expiresAt)) throw new StateError("EXPIRED");
      if (this.one("SELECT proposal FROM claims WHERE site=? AND issue=?", plan.site, plan.issueId)) throw new StateError("BUSY");
      this.run("INSERT INTO claims VALUES(?,?,?)", plan.site, plan.issueId, plan.id);
      execution.state = "applying";
    }, at);
  }
  acknowledgeReview(proposalId: string, revision: number, reviewHash: string): StoredChange {
    if (!Sha256.safeParse(reviewHash).success) throw new StateError("INVALID");
    const at = this.at();
    return this.update(proposalId, revision, `reviewed:${reviewHash}`, ({ plan, execution }) => {
      if (execution.state !== "prepared") throw new StateError("CONFLICT");
      if (Date.parse(at) < Date.parse(plan.createdAt) || Date.parse(at) >= Date.parse(plan.expiresAt)) throw new StateError("EXPIRED");
    }, at);
  }
  resume(proposalId: string, revision: number): StoredChange {
    const at = this.at();
    return this.update(proposalId, revision, "continued", ({ plan, execution, receipts }) => {
      if (execution.state !== "unknown" || !Object.keys(receipts).length || !execution.steps.some((step) => step.state === "pending") || execution.steps.some((step) => step.state !== "pending" && (step.state !== "confirmed" || !receipts[step.id]?.verifiedAt))) throw new StateError("CONFLICT");
      if (Date.parse(at) < Date.parse(plan.createdAt) || Date.parse(at) >= Date.parse(plan.expiresAt)) throw new StateError("EXPIRED");
      const owner = this.one("SELECT proposal FROM claims WHERE site=? AND issue=?", plan.site, plan.issueId);
      if (!owner || owner.proposal !== proposalId) throw new StateError("CONFLICT");
      execution.state = "applying";
    }, at);
  }
  hasReviewed(proposalId: string, reviewHash: string): boolean {
    this.get(proposalId);
    return Sha256.safeParse(reviewHash).success && Boolean(this.one("SELECT sequence FROM events WHERE proposal=? AND event=? LIMIT 1", proposalId, `reviewed:${reviewHash}`));
  }
  sending(proposalId: string, revision: number, stepId: string, value?: string): StoredChange {
    const at = this.at(value);
    return this.update(proposalId, revision, "sending", ({ plan, execution, receipts }) => {
      if (execution.state !== "applying") throw new StateError("CONFLICT");
      if (Date.parse(at) < Date.parse(plan.createdAt) || Date.parse(at) >= Date.parse(plan.expiresAt)) throw new StateError("EXPIRED");
      const index = execution.steps.findIndex((step) => step.id === stepId);
      const step = execution.steps[index];
      if (!step || step.state !== "pending" || execution.steps.slice(0, index).some((step) => !receipts[step.id]?.verifiedAt)) throw new StateError("CONFLICT");
      for (const ref of plan.steps[index]!.fileRefs) verifyPinnedFile(join(this.paths.staging, ref), plan.files.find((file) => file.stagedRef === ref)!);
      step.state = "sending";
    }, at);
  }
  confirm(proposalId: string, revision: number, stepId: string, input: StepReceipt): StoredChange {
    const parsed = StepReceiptSchema.omit({ verifiedAt: true }).safeParse(input);
    if (!parsed.success) throw new StateError("INVALID");
    const receipt = parsed.data;
    return this.update(proposalId, revision, "confirmed", ({ execution }) => {
      const step = execution.steps.find((step) => step.id === stepId);
      if (execution.state !== "applying" || step?.state !== "sending") throw new StateError("CONFLICT");
      this.run("INSERT INTO receipts VALUES(?,?,?)", proposalId, stepId, canonicalJSON(receipt)); step.state = "confirmed";
    }, receipt.confirmedAt);
  }
  verified(proposalId: string, revision: number, stepId: string, value?: string, continuationUpdated?: string): StoredChange {
    if (continuationUpdated !== undefined && !Timestamp.safeParse(continuationUpdated).success) throw new StateError("INVALID");
    const at = this.at(value);
    return this.update(proposalId, revision, "verified", ({ execution, receipts }) => {
      const receipt = receipts[stepId];
      if (!["applying", "unknown", "failed"].includes(execution.state) || !receipt || receipt.verifiedAt) throw new StateError("CONFLICT");
       receipt.verifiedAt = at;
       if (continuationUpdated !== undefined) receipt.continuationUpdated = continuationUpdated;
      this.run("UPDATE receipts SET document=? WHERE proposal=? AND step=?", canonicalJSON(receipt), proposalId, stepId);
      if (execution.steps.every((step) => receipts[step.id]?.verifiedAt)) {
        execution.state = "applied";
        this.run("DELETE FROM claims WHERE proposal=?", proposalId);
      }
    }, at);
  }
  stop(proposalId: string, revision: number, stepId: string | undefined, outcome: "failed" | "unknown", value?: string, rejectionStatus?: number): StoredChange {
    if (rejectionStatus !== undefined && (outcome !== "failed" || !Number.isInteger(rejectionStatus) || rejectionStatus < 400 || rejectionStatus > 499)) throw new StateError("INVALID");
    return this.update(proposalId, revision, outcome, ({ execution }) => {
      if (execution.state !== "applying") throw new StateError("CONFLICT");
      const step = execution.steps.find((step) => step.id === stepId);
      if (stepId !== undefined && !step) throw new StateError("CONFLICT");
      if (outcome === "failed") {
        if (step && !["pending", "sending"].includes(step.state) || execution.steps.some((other) => other !== step && ["sending", "unknown"].includes(other.state))) throw new StateError("CONFLICT");
        if (step) { step.state = "failed"; if (rejectionStatus !== undefined) step.rejectionStatus = rejectionStatus; }
        if (execution.steps.some((other) => other.state === "sending")) throw new StateError("CONFLICT");
        if (!execution.steps.some((other) => other.state === "confirmed")) this.run("DELETE FROM claims WHERE proposal=?", proposalId);
      } else {
        if (step && step.state !== "sending") throw new StateError("CONFLICT");
        for (const other of execution.steps) if (other.state === "sending") other.state = "unknown";
      }
      execution.state = outcome;
    }, value);
  }
  private recover(): void {
    for (const row of this.all("SELECT id FROM executions WHERE state='applying'")) {
      const { execution } = this.get(String(row.id));
      this.update(execution.proposalId, execution.revision, "recovered-unknown", ({ execution }) => {
        execution.state = "unknown";
        for (const step of execution.steps) if (step.state === "sending") step.state = "unknown";
      });
    }
  }

  usage(): { databaseBytes: number; stagingBytes: number } {
    const databaseBytes = (Number(this.one("PRAGMA page_count")!.page_count) - Number(this.one("PRAGMA freelist_count")!.freelist_count)) * Number(this.one("PRAGMA page_size")!.page_size);
    let stagingBytes = 0;
    for (const ref of readdirSync(this.paths.staging)) { const path = join(this.paths.staging, ref); assertPrivateFile(path); stagingBytes += lstatSync(path).size; }
    return { databaseBytes, stagingBytes };
  }
  private fits(requiredBytes: number, stagingBytes = 0): boolean {
    const usage = this.usage();
    const disk = statfsSync(this.paths.staging, { bigint: true });
    return usage.databaseBytes + requiredBytes <= this.limits.databaseBytes - this.limits.reserveBytes && usage.stagingBytes + stagingBytes <= this.limits.stagingBytes
      && disk.bavail * disk.bsize >= BigInt(requiredBytes + stagingBytes + this.limits.reserveBytes);
  }
  reserveStaging(bytes: number): { check: () => void; release: () => void } {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(bytes + this.stagingReserved)) throw new StateError("INVALID");
    this.collect(undefined, 65536, bytes + this.stagingReserved);
    const check = () => {
      this.database();
      const disk = statfsSync(this.paths.staging, { bigint: true });
      if (disk.bavail * disk.bsize < BigInt(this.stagingReserved + this.limits.reserveBytes)) throw new StateError("QUOTA");
    };
    // Keep the full reservation until release, even while its partial file also counts in usage.
    this.stagingReserved += bytes; this.stagingLeases++;
    try { check(); }
    catch (error) { this.stagingReserved -= bytes; this.stagingLeases--; throw error; }
    let released = false;
    return {
      check: () => { if (released) throw new StateError("CLOSED"); check(); },
      release: () => { if (!released) { released = true; this.stagingReserved -= bytes; this.stagingLeases--; } },
    };
  }
  private eligible(at: string): Array<{ id: string; since: number; normal: boolean }> {
    const now = Date.parse(at);
    const result: Array<{ id: string; since: number; normal: boolean }> = [];
    for (const row of this.all("SELECT id FROM executions WHERE state IN ('prepared','applied','failed')")) {
      const { plan, execution } = this.get(String(row.id));
      if (execution.state === "failed" && execution.steps.some((step) => step.state === "confirmed")) continue;
      if (this.one("SELECT proposal FROM claims WHERE proposal=?", plan.id)) throw new StateError("CORRUPT");
      if (execution.state === "prepared" && Date.parse(plan.expiresAt) <= now) result.push({ id: plan.id, since: Date.parse(plan.expiresAt), normal: now - Date.parse(plan.expiresAt) >= this.limits.expiredMs });
      const terminal = execution.state === "applied" || execution.state === "failed" && execution.steps.every((step) => ["pending", "failed"].includes(step.state));
      if (terminal) result.push({ id: plan.id, since: Date.parse(execution.updatedAt), normal: now - Date.parse(execution.updatedAt) >= this.limits.terminalMs });
    }
    return result.sort((a, b) => a.since - b.since || a.id.localeCompare(b.id));
  }
  private deleteEligible(proposalId: string): void {
    this.transaction(() => {
      for (const file of this.all("SELECT ref, size, hash FROM files WHERE proposal=?", proposalId)) this.run("INSERT INTO staging_gc VALUES(?,?,?)", file.ref!, file.size!, file.hash!);
      this.run("DELETE FROM plans WHERE id=?", proposalId);
    });
    try { this.options.fault?.("after-retention-commit"); } catch { throw new StateError("IO"); }
    this.sweepStaging();
  }
  private sweepStaging(): void {
    for (const row of this.all("SELECT ref, size, hash FROM staging_gc")) {
      const path = join(this.paths.staging, String(row.ref));
      if (verifyPinnedFile(path, { size: Number(row.size), sha256: String(row.hash) }, true)) { unlinkSync(path); syncDirectory(this.paths.staging); }
      this.transaction(() => this.run("DELETE FROM staging_gc WHERE ref=?", row.ref!));
    }
  }
  collect(value?: string, requiredBytes = 0, stagingBytes = 0): string[] {
    if (![requiredBytes, stagingBytes].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new StateError("INVALID");
    const at = this.at(value);
    this.sweepStaging();
    const removed: string[] = [];
    const candidates = this.eligible(at);
    for (const candidate of candidates) if (candidate.normal) { this.deleteEligible(candidate.id); removed.push(candidate.id); }
    if (requiredBytes || stagingBytes) {
      for (const candidate of candidates) {
        if (this.fits(requiredBytes, stagingBytes)) break;
        if (removed.includes(candidate.id)) continue;
        this.deleteEligible(candidate.id); removed.push(candidate.id);
      }
      if (!this.fits(requiredBytes, stagingBytes)) throw new StateError("QUOTA");
    }
    return removed;
  }
  countByState(): Record<string, number> {
    const result: Record<string, number> = { prepared: 0, applying: 0, applied: 0, failed: 0, unknown: 0 };
    for (const row of this.all("SELECT state, COUNT(*) AS count FROM executions GROUP BY state")) {
      if (!Object.hasOwn(result, String(row.state))) throw new StateError("CORRUPT");
      result[String(row.state)] = Number(row.count);
    }
    return result;
  }
  diagnostics(): { prepared: number; applying: number; applied: number; failed: number; unknown: number } {
    return this.countByState() as { prepared: number; applying: number; applied: number; failed: number; unknown: number };
  }
  assertMaintenanceSafe(): void {
    if (this.stagingLeases) throw new StateError("BUSY");
    const counts = this.diagnostics();
    if (counts.applying || counts.unknown) throw new StateError("BUSY");
    for (const row of this.all("SELECT id FROM executions WHERE state='failed'")) if (this.get(String(row.id)).execution.steps.some((step) => step.state === "confirmed")) throw new StateError("BUSY");
  }
  events(proposalId: string): Array<{ revision: number; event: string; at: string; requestId: string }> {
    return this.all("SELECT revision, event, at, request_id FROM events WHERE proposal=? ORDER BY sequence", proposalId).map((row) => ({ revision: Number(row.revision), event: String(row.event), at: String(row.at), requestId: String(row.request_id) }));
  }
  close(): void {
    if (this.stagingLeases) throw new StateError("BUSY");
    try { this.db?.close(); }
    finally {
      this.db = undefined;
      try { this.owner?.close(); }
      finally {
        this.owner = undefined;
        if (this.ownerKey) owners().delete(this.ownerKey);
        this.ownerKey = undefined;
      }
    }
  }
}

export interface ExecutionDigest {
  state: string;
  updatedAt: string;
  steps: string[];
  files: number;
  receipts: number;
  verifiedReceipts: number;
}
export interface ExecutionDigests {
  states: Record<string, number>;
  executions: ExecutionDigest[];
}

function openReadonly(data: string): Database.Database | undefined {
  const paths = statePaths(data);
  if (!existsSync(paths.database)) return undefined;
  try { return new Database(paths.database, { readonly: true, fileMustExist: true }); }
  catch (error) {
    if (String((error as { code?: string }).code ?? "").startsWith("SQLITE_BUSY")) throw new StateError("BUSY");
    throw new StateError("CORRUPT");
  }
}

// Read-only aggregate over the executions: it never opens the store for
// writing, never purges and never takes the owner lock. Documents are parsed
// defensively for counts only; no plan or receipt content leaves this module.
export function readExecutionDigests(data: string): ExecutionDigests {
  const states: Record<string, number> = { prepared: 0, applying: 0, applied: 0, failed: 0, unknown: 0 };
  const executions: ExecutionDigest[] = [];
  const db = openReadonly(data);
  if (!db) return { states, executions };
  try {
    const rows = db.prepare<[], Row>("SELECT e.id AS id, e.state AS state, e.updated_at AS updated_at, e.document AS execution, p.document AS plan FROM executions e JOIN plans p ON p.id=e.id ORDER BY e.id").all();
    const receiptsStatement = db.prepare<[Scalar], Row>("SELECT document FROM receipts WHERE proposal=?");
    for (const row of rows) {
      const state = String(row.state);
      if (!Object.hasOwn(states, state)) throw new StateError("CORRUPT");
      states[state] = (states[state] ?? 0) + 1;
      let steps: string[] = [];
      let files = 0;
      let receipts = 0;
      let verifiedReceipts = 0;
      try {
        const execution = JSON.parse(String(row.execution)) as { steps?: Array<{ state?: unknown }> };
        steps = Array.isArray(execution.steps) ? execution.steps.map((step) => String(step?.state)) : [];
        const plan = JSON.parse(String(row.plan)) as { files?: unknown };
        files = Array.isArray(plan.files) ? plan.files.length : 0;
        for (const receipt of receiptsStatement.all(String(row.id))) {
          receipts++;
          const document = JSON.parse(String(receipt.document)) as { verifiedAt?: unknown };
          if (typeof document.verifiedAt === "string" && document.verifiedAt) verifiedReceipts++;
        }
      } catch (error) {
        if (error instanceof StateError) throw error;
        throw new StateError("CORRUPT");
      }
      executions.push({ state: String(row.state), updatedAt: String(row.updated_at), steps, files, receipts, verifiedReceipts });
    }
    return { states, executions };
  } catch (error) {
    if (String((error as { code?: string }).code ?? "").startsWith("SQLITE_BUSY")) throw new StateError("BUSY");
    if (error instanceof StateError) throw error;
    throw new StateError("CORRUPT");
  } finally { db.close(); }
}
