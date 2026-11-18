import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import { ChangeStore, type StoreOptions } from "./store.js";
import { StateError } from "./errors.js";
import { statePaths, userDataDirectory } from "./paths.js";
import { privateDirectory } from "./files.js";

interface Waiter { start: () => void; reject: (error: unknown) => void; signal?: AbortSignal; abort?: () => void }
interface Gate { busy: boolean; queue: Waiter[] }
interface Coordination { version: 1; gates: Map<string, Gate>; context: AsyncLocalStorage<Set<string>> }
const key = Symbol.for("issuekeeper.jira.state-coordinator.v1");
function coordination(): Coordination {
  const global = globalThis as typeof globalThis & { [key: symbol]: unknown };
  if (global[key] === undefined) global[key] = { version: 1, gates: new Map(), context: new AsyncLocalStorage() };
  const state = global[key] as Coordination;
  if (state.version !== 1 || !(state.gates instanceof Map) || !(state.context instanceof AsyncLocalStorage)) throw new StateError("INCOMPATIBLE");
  return state;
}

// Store ownership spans the callback, not a SQL transaction across permission/network waits.
export async function withChangeStore<T>(
  callback: (store: ChangeStore) => Promise<T> | T,
  options: StoreOptions & { data?: string; signal?: AbortSignal } = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  const data = options.data ?? userDataDirectory();
  const path = statePaths(data).directory;
  privateDirectory(path);
  const directory = realpathSync(path);
  const state = coordination();
  if (state.context.getStore()?.has(directory)) throw new StateError("BUSY");
  const gate = state.gates.get(directory) ?? { busy: false, queue: [] };
  state.gates.set(directory, gate);
  if (options.mode === "maintenance" && gate.busy) throw new StateError("BUSY");
  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = { start: resolve, reject, signal: options.signal };
    if (!gate.busy) { gate.busy = true; resolve(); return; }
    waiter.abort = () => {
      const index = gate.queue.indexOf(waiter);
      if (index >= 0) { gate.queue.splice(index, 1); reject(options.signal!.reason); }
    };
    gate.queue.push(waiter);
    options.signal?.addEventListener("abort", waiter.abort, { once: true });
    if (options.signal?.aborted) waiter.abort();
  });
  let store: ChangeStore | undefined;
  try {
    options.signal?.throwIfAborted();
    store = new ChangeStore(data, options);
    if (options.mode === "maintenance") store.assertMaintenanceSafe();
    const active = new Set(state.context.getStore() ?? []); active.add(directory);
    return await state.context.run(active, () => callback(store!));
  } finally {
    try { store?.close(); }
    finally {
      const next = gate.queue.shift();
      if (next) {
        if (next.abort) next.signal?.removeEventListener("abort", next.abort);
        next.start();
      } else { gate.busy = false; state.gates.delete(directory); }
    }
  }
}
