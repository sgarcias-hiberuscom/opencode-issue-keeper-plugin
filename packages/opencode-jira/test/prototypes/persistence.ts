import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/)
  .refine((value) => Number.isFinite(Date.parse(value)));
const StepSchema = z.strictObject({
  id,
  kind: z.enum(["mutation", "temporary-upload", "publish-attachments"]),
  fileRefs: z.array(id).max(5),
});
const PlanSchema = z.strictObject({
  version: z.literal(1), id, sessionID: id, locationID: hash, account: id,
  site: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  }),
  credentialIdentity: id, issueId: id, issueKey: id, policyFingerprint: hash,
  expectedUpdated: date, createdAt: date, expiresAt: date,
  change: z.json(), steps: z.array(StepSchema).min(1).max(10),
}).refine((plan) => Date.parse(plan.expiresAt) > Date.parse(plan.createdAt))
  .refine((plan) => new Set(plan.steps.map((step) => step.id)).size === plan.steps.length);
const ExecutionSchema = z.strictObject({
  proposalId: id, payloadHash: hash, revision: z.number().int().nonnegative(),
  state: z.enum(["prepared", "applying", "applied", "failed", "unknown"]), updatedAt: date,
  steps: z.array(z.strictObject({
    id, state: z.enum(["pending", "sending", "confirmed", "failed", "unknown"]),
  })),
});
const ReceiptSchema = z.strictObject({
  remoteIds: z.array(id).max(10), temporaryAttachmentIds: z.array(id).max(5),
  confirmedAt: date, verifiedAt: date.optional(),
});

export type SyntheticPlan = z.infer<typeof PlanSchema>;
export type SyntheticExecution = z.infer<typeof ExecutionSchema>;
export type SyntheticReceipt = z.infer<typeof ReceiptSchema>;
type Snapshot = { plan: SyntheticPlan; payloadHash: string; execution: SyntheticExecution; receipts: Record<string, SyntheticReceipt> };
type Fault = (point: "before-commit") => void;

export class PrototypeError extends Error {
  readonly code: "INVALID" | "UNSAFE_PATH" | "BUSY" | "CORRUPT" | "CONFLICT" | "EXPIRED" | "CLOSED" | "STORAGE";
  constructor(code: PrototypeError["code"]) {
    super(`Persistence prototype: ${code}`);
    this.code = code;
  }
}

export function canonicalJSON(value: unknown): string {
  const active = new Set<object>();
  let nodes = 0;
  function encode(item: unknown, depth: number): string {
    if (++nodes > 10000 || depth > 32) throw new PrototypeError("INVALID");
    if (item === null || typeof item === "boolean" || typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || !item || active.has(item)) throw new PrototypeError("INVALID");
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new PrototypeError("INVALID");
    active.add(item);
    const keys = Reflect.ownKeys(item);
    if (keys.some((key) => typeof key !== "string")) throw new PrototypeError("INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.entries(descriptors).some(([key, descriptor]) => (!array || key !== "length") && (!descriptor.enumerable || !("value" in descriptor)))) throw new PrototypeError("INVALID");
    let result: string;
    if (array) {
      if (keys.length !== item.length + 1) throw new PrototypeError("INVALID");
      const entries: string[] = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) throw new PrototypeError("INVALID");
        entries.push(encode(descriptor.value, depth + 1));
      }
      result = `[${entries.join(",")}]`;
    } else {
      result = `{${(keys as string[]).sort().map((key) => `${JSON.stringify(key)}:${encode(descriptors[key]!.value, depth + 1)}`).join(",")}}`;
    }
    active.delete(item);
    return result;
  }
  const result = encode(value, 0);
  if (Buffer.byteLength(result) > 1024 * 1024) throw new PrototypeError("INVALID");
  return result;
}

export function planHash(plan: SyntheticPlan): string {
  return createHash("sha256").update(canonicalJSON(plan)).digest("hex");
}

function parse<T>(schema: z.ZodType<T>, value: unknown, code: "INVALID" | "CORRUPT"): T {
  try {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
  } catch { /* Invalid representations are reported without input values. */ }
  throw new PrototypeError(code);
}

function privateFile(path: string): boolean {
  let created = false;
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new PrototypeError("UNSAFE_PATH");
    descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) throw new PrototypeError("UNSAFE_PATH");
  } finally { closeSync(descriptor); }
  return created;
}

function checkSidecars(path: string): void {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try {
      const stat = lstatSync(path + suffix);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new PrototypeError("UNSAFE_PATH");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

// The ownership transaction uses a separate database so it cannot block journal commits.
export class PersistencePrototype {
  private owner: DatabaseSync | undefined;
  private db: DatabaseSync | undefined;
  private fault: Fault | undefined;

  constructor(directory: string, fault?: Fault) {
    this.fault = fault;
    try {
      const stat = lstatSync(directory);
      if (!isAbsolute(directory) || realpathSync(directory) !== directory || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new PrototypeError("UNSAFE_PATH");
      const ownerPath = join(directory, "owner.sqlite");
      privateFile(ownerPath);
      checkSidecars(ownerPath);
      this.owner = new DatabaseSync(ownerPath);
      try { this.owner.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); }
      catch (error) {
        const code = (error as { errcode?: number }).errcode;
        throw new PrototypeError(code === 5 || code === 6 ? "BUSY" : "CORRUPT");
      }
      const path = join(directory, "state.sqlite");
      const created = privateFile(path);
      checkSidecars(path);
      this.db = new DatabaseSync(path);
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0");
      if (created) this.initialize();
      this.validate();
      if (created) {
        const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      }
      this.recover();
    } catch (error) {
      this.close();
      if (error instanceof PrototypeError) throw error;
      throw new PrototypeError("CORRUPT");
    }
  }

  private database(): DatabaseSync {
    if (!this.db) throw new PrototypeError("CLOSED");
    return this.db;
  }

  private transaction<T>(callback: () => T): T {
    const db = this.database();
    let active = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      active = true;
      const result = callback();
      this.fault?.("before-commit");
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (active) try { db.exec("ROLLBACK"); } catch { this.close(); }
      if (error instanceof PrototypeError) throw error;
      throw new PrototypeError("STORAGE");
    }
  }

  private initialize(): void {
    this.transaction(() => this.database().exec(`
      PRAGMA application_id=1229671248;
      PRAGMA user_version=1;
      CREATE TABLE plans (id TEXT PRIMARY KEY, hash TEXT NOT NULL, document TEXT NOT NULL) STRICT;
      CREATE TABLE executions (id TEXT PRIMARY KEY REFERENCES plans(id), revision INTEGER NOT NULL, document TEXT NOT NULL) STRICT;
      CREATE TABLE receipts (proposal TEXT NOT NULL REFERENCES plans(id), step TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(proposal, step)) STRICT;
      CREATE TABLE claims (site TEXT NOT NULL, issue TEXT NOT NULL, proposal TEXT UNIQUE NOT NULL REFERENCES plans(id), PRIMARY KEY(site, issue)) STRICT;
      CREATE TABLE events (sequence INTEGER PRIMARY KEY, proposal TEXT NOT NULL REFERENCES plans(id), revision INTEGER NOT NULL, event TEXT NOT NULL, at TEXT NOT NULL) STRICT;
    `));
  }

  private validate(): void {
    const db = this.database();
    if (db.prepare("PRAGMA user_version").get()?.user_version !== 1 || db.prepare("PRAGMA application_id").get()?.application_id !== 1229671248) throw new PrototypeError("CORRUPT");
    if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") throw new PrototypeError("CORRUPT");
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || db.prepare("PRAGMA foreign_key_check").all().length) throw new PrototypeError("CORRUPT");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
    if (canonicalJSON(tables) !== canonicalJSON(["claims", "events", "executions", "plans", "receipts"])) throw new PrototypeError("CORRUPT");
    for (const row of db.prepare("SELECT id FROM plans").all()) this.get(String(row.id));
    for (const row of db.prepare("SELECT site, issue, proposal FROM claims").all()) {
      const snapshot = this.get(String(row.proposal));
      if (snapshot.plan.site !== row.site || snapshot.plan.issueId !== row.issue || !["applying", "unknown"].includes(snapshot.execution.state)) throw new PrototypeError("CORRUPT");
    }
    for (const row of db.prepare("SELECT id FROM executions").all()) {
      const { execution } = this.get(String(row.id));
      const claim = db.prepare("SELECT proposal FROM claims WHERE proposal=?").get(String(row.id));
      if (["applying", "unknown"].includes(execution.state) !== Boolean(claim)) throw new PrototypeError("CORRUPT");
    }
  }

  private event(execution: SyntheticExecution, event: string): void {
    this.database().prepare("INSERT INTO events(proposal, revision, event, at) VALUES(?,?,?,?)").run(execution.proposalId, execution.revision, event, execution.updatedAt);
  }

  prepare(input: SyntheticPlan): Snapshot {
    // Validate JSON before a schema parser can discard unsupported properties or invoke getters.
    const plan = parse(PlanSchema, JSON.parse(canonicalJSON(input)), "INVALID");
    const payloadHash = planHash(plan);
    const execution: SyntheticExecution = {
      proposalId: plan.id, payloadHash, revision: 0, state: "prepared", updatedAt: plan.createdAt,
      steps: plan.steps.map((step) => ({ id: step.id, state: "pending" })),
    };
    this.transaction(() => {
      const db = this.database();
      if (db.prepare("SELECT id FROM plans WHERE id=?").get(plan.id)) throw new PrototypeError("CONFLICT");
      db.prepare("INSERT INTO plans VALUES(?,?,?)").run(plan.id, payloadHash, canonicalJSON(plan));
      db.prepare("INSERT INTO executions VALUES(?,?,?)").run(plan.id, 0, canonicalJSON(execution));
      this.event(execution, "prepared");
    });
    return this.get(plan.id);
  }

  get(proposalId: string): Snapshot {
    const row = this.database().prepare("SELECT p.document AS plan, p.hash, e.document AS execution, e.revision FROM plans p LEFT JOIN executions e ON p.id=e.id WHERE p.id=?").get(proposalId);
    if (!row) throw new PrototypeError("CONFLICT");
    try {
      const plan = parse(PlanSchema, JSON.parse(String(row.plan)), "CORRUPT");
      const execution = parse(ExecutionSchema, JSON.parse(String(row.execution)), "CORRUPT");
      if (plan.id !== proposalId || planHash(plan) !== row.hash || execution.payloadHash !== row.hash || execution.proposalId !== proposalId || execution.revision !== row.revision || canonicalJSON(execution.steps.map((step) => step.id)) !== canonicalJSON(plan.steps.map((step) => step.id))) throw new PrototypeError("CORRUPT");
      const receipts: Record<string, SyntheticReceipt> = Object.create(null);
      for (const receipt of this.database().prepare("SELECT step, document FROM receipts WHERE proposal=?").all(proposalId)) {
        const step = execution.steps.find((step) => step.id === receipt.step);
        if (!step || step.state !== "confirmed") throw new PrototypeError("CORRUPT");
        receipts[String(receipt.step)] = parse(ReceiptSchema, JSON.parse(String(receipt.document)), "CORRUPT");
      }
      if (execution.steps.some((step) => (step.state === "confirmed") !== Boolean(receipts[step.id]))) throw new PrototypeError("CORRUPT");
      if (execution.state === "prepared" && execution.steps.some((step) => step.state !== "pending")) throw new PrototypeError("CORRUPT");
      if (execution.state === "applied" && execution.steps.some((step) => !receipts[step.id]?.verifiedAt)) throw new PrototypeError("CORRUPT");
      return { plan, payloadHash: String(row.hash), execution, receipts };
    } catch { throw new PrototypeError("CORRUPT"); }
  }

  private update(proposalId: string, revision: number, at: string, event: string, change: (snapshot: Snapshot) => void): Snapshot {
    parse(date, at, "INVALID");
    this.transaction(() => {
      const snapshot = this.get(proposalId);
      if (snapshot.execution.revision !== revision) throw new PrototypeError("CONFLICT");
      change(snapshot);
      snapshot.execution.revision++;
      snapshot.execution.updatedAt = at;
      const result = this.database().prepare("UPDATE executions SET document=?, revision=? WHERE id=? AND revision=?").run(canonicalJSON(snapshot.execution), snapshot.execution.revision, proposalId, revision);
      if (result.changes !== 1) throw new PrototypeError("CONFLICT");
      this.event(snapshot.execution, event);
    });
    return this.get(proposalId);
  }

  claim(proposalId: string, revision: number, at: string): Snapshot {
    return this.update(proposalId, revision, at, "claimed", ({ plan, execution }) => {
      if (execution.state !== "prepared") throw new PrototypeError("CONFLICT");
      if (Date.parse(at) < Date.parse(plan.createdAt) || Date.parse(at) >= Date.parse(plan.expiresAt)) throw new PrototypeError("EXPIRED");
      const db = this.database();
      if (db.prepare("SELECT proposal FROM claims WHERE site=? AND issue=?").get(plan.site, plan.issueId)) throw new PrototypeError("BUSY");
      db.prepare("INSERT INTO claims VALUES(?,?,?)").run(plan.site, plan.issueId, plan.id);
      execution.state = "applying";
    });
  }

  sending(proposalId: string, revision: number, stepId: string, at: string): Snapshot {
    return this.update(proposalId, revision, at, "sending", ({ plan, execution, receipts }) => {
      if (execution.state !== "applying") throw new PrototypeError("CONFLICT");
      if (Date.parse(at) >= Date.parse(plan.expiresAt)) throw new PrototypeError("EXPIRED");
      const index = execution.steps.findIndex((step) => step.id === stepId);
      const step = execution.steps[index];
      if (!step || step.state !== "pending" || execution.steps.slice(0, index).some((step) => !receipts[step.id]?.verifiedAt)) throw new PrototypeError("CONFLICT");
      step.state = "sending";
    });
  }

  confirm(proposalId: string, revision: number, stepId: string, receipt: SyntheticReceipt): Snapshot {
    const final = parse(ReceiptSchema.omit({ verifiedAt: true }), receipt, "INVALID");
    return this.update(proposalId, revision, final.confirmedAt, "confirmed", ({ execution }) => {
      const step = execution.steps.find((step) => step.id === stepId);
      if (execution.state !== "applying" || step?.state !== "sending") throw new PrototypeError("CONFLICT");
      this.database().prepare("INSERT INTO receipts VALUES(?,?,?)").run(proposalId, stepId, canonicalJSON(final));
      step.state = "confirmed";
    });
  }

  verified(proposalId: string, revision: number, stepId: string, at: string): Snapshot {
    return this.update(proposalId, revision, at, "verified", ({ execution, receipts }) => {
      const receipt = receipts[stepId];
      if (!["applying", "unknown"].includes(execution.state) || !receipt || receipt.verifiedAt) throw new PrototypeError("CONFLICT");
      receipt.verifiedAt = at;
      this.database().prepare("UPDATE receipts SET document=? WHERE proposal=? AND step=?").run(canonicalJSON(receipt), proposalId, stepId);
      if (execution.steps.every((step) => receipts[step.id]?.verifiedAt)) {
        execution.state = "applied";
        this.database().prepare("DELETE FROM claims WHERE proposal=?").run(proposalId);
      }
    });
  }

  private recover(): void {
    for (const row of this.database().prepare("SELECT id FROM executions").all()) {
      const { execution } = this.get(String(row.id));
      if (execution.state !== "applying") continue;
      this.update(execution.proposalId, execution.revision, new Date().toISOString(), "recovered-unknown", ({ execution }) => {
        execution.state = "unknown";
        for (const step of execution.steps) if (step.state === "sending") step.state = "unknown";
      });
    }
  }

  events(proposalId: string): Array<{ revision: number; event: string }> {
    return this.database().prepare("SELECT revision, event FROM events WHERE proposal=? ORDER BY sequence").all(proposalId).map((row) => ({ revision: Number(row.revision), event: String(row.event) }));
  }

  close(): void {
    try { this.db?.close(); }
    finally {
      this.db = undefined;
      try { this.owner?.close(); }
      finally { this.owner = undefined; }
    }
  }
}
