import { AsyncLocalStorage } from "node:async_hooks";

export interface Operation {
  requestId: string;
  tool: string;
  account?: string;
  operation: string;
  status?: number;
  attempts: number;
  warnings: string[];
}
export const operations = new AsyncLocalStorage<Operation>();

export function recordWarnings(warnings: readonly string[]): void {
  operations.getStore()?.warnings.push(...warnings);
}
