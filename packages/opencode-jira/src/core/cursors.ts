import { createHash, randomUUID } from "node:crypto";
import { IssueKeeperError } from "../errors.js";

interface Cursor { scope: string; position: string | number; seen: string[]; expires: number }
export class Cursors {
  private readonly entries = new Map<string, Cursor>();
  scope(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
  get(id: string | undefined, scope: string): Cursor | undefined {
    if (!id) return undefined;
    const cursor = this.entries.get(id);
    if (!cursor || cursor.scope !== scope || cursor.expires < Date.now()) throw new IssueKeeperError("CURSOR_INVALID", "Cursor caducado o de otra cuenta/consulta; comience de nuevo.");
    return cursor;
  }
  next(scope: string, position: string | number | undefined, previous?: Cursor): string | undefined {
    if (position === undefined) return undefined;
    const seen = previous ? [...previous.seen, String(previous.position)] : [];
    if (seen.includes(String(position)) || seen.length >= 100) throw new IssueKeeperError("CURSOR_INVALID", "Paginación repetida o presupuesto de 100 páginas agotado.");
    for (const [id, entry] of this.entries) if (entry.expires < Date.now()) this.entries.delete(id);
    if (this.entries.size >= 1000) this.entries.delete(this.entries.keys().next().value!);
    const id = randomUUID();
    this.entries.set(id, { scope, position, seen, expires: Date.now() + 600000 });
    return id;
  }
  close(): void { this.entries.clear(); }
}
