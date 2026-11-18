import type { ChangePlan, StoredChange } from "../core/proposals.js";
import { ChangeApplication, type ChangeContext, type ChangePorts } from "./application.js";
import { userDataDirectory } from "./paths.js";
import { StateError } from "./errors.js";
import type { StoreOptions } from "./store.js";
import type { ChangeStore } from "./store.js";

export class ChangeRuntime {
  private readonly shutdown = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  constructor(private readonly options: StoreOptions & { data?: string } = {}) {}

  private async run<Binding>(context: ChangeContext, ports: ChangePorts<Binding>, operation: (application: ChangeApplication<Binding>, context: ChangeContext) => Promise<StoredChange>): Promise<StoredChange> {
    if (this.shutdown.signal.aborted) throw new StateError("CLOSED");
    const scoped = { ...context, signal: AbortSignal.any([context.signal, this.shutdown.signal]) };
    const application = new ChangeApplication(ports, { ...this.options, data: this.options.data ?? userDataDirectory() });
    const task = operation(application, scoped);
    this.active.add(task);
    try { return await task; } finally { this.active.delete(task); }
  }
  prepare<Binding>(plan: ChangePlan, context: ChangeContext, ports: ChangePorts<Binding>): Promise<StoredChange> { return this.run(context, ports, (application, context) => application.prepare(plan, context)); }
  prepareGenerated<Binding>(build: (store: ChangeStore, context: ChangeContext) => Promise<ChangePlan>, context: ChangeContext, ports: ChangePorts<Binding>): Promise<StoredChange> { return this.run(context, ports, (application, context) => application.prepareGenerated(build, context)); }
  apply<Binding>(proposalId: string, context: ChangeContext, ports: ChangePorts<Binding>): Promise<StoredChange> { return this.run(context, ports, (application, context) => application.apply(proposalId, context)); }
  verifyConfirmed<Binding>(proposalId: string, context: ChangeContext, ports: ChangePorts<Binding>): Promise<StoredChange> { return this.run(context, ports, (application, context) => application.verifyConfirmed(proposalId, context)); }

  close(): Promise<void> {
    if (!this.closing) {
      this.shutdown.abort();
      this.closing = Promise.allSettled([...this.active]).then(() => {});
    }
    return this.closing;
  }
}
