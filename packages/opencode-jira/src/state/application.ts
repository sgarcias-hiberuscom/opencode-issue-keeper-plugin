import type { ChangePlan, StepReceipt, StoredChange } from "../core/proposals.js";
import { planHash, validatePlan } from "../core/proposals.js";
import { assertReviewed, changeReview, type ChangeReview, type ReviewEvidence } from "../core/review.js";
import { cancellation, IssueKeeperError } from "../errors.js";
import { metrics } from "../metrics.js";
import { withChangeStore } from "./coordinator.js";
import { StateError } from "./errors.js";
import type { ChangeStore, StoreOptions } from "./store.js";

export interface ChangeContext {
  sessionID: string;
  signal: AbortSignal;
  resolve: () => Promise<{ sessionID: string; locationID: string }>;
  onAccount?: (account: string) => void;
}
export interface ChangeValidation<Binding> {
  account: string; site: string; credentialIdentity: string; issueId: string; issueKey: string; projectKey: string;
  policyFingerprint: string; updated: string; binding: Binding;
}
export type StepOutcome = { outcome: "confirmed"; receipt: StepReceipt } | { outcome: "rejected"; status?: number } | { outcome: "unknown" };
type Step = ChangePlan["steps"][number];
export interface ChangePorts<Binding> {
  validate: (plan: ChangePlan, context: ChangeContext, purpose?: "apply" | "verify", progress?: StoredChange) => Promise<ChangeValidation<Binding>>;
  present: (review: ChangeReview, context: ChangeContext, recorded?: ReviewEvidence) => Promise<ReviewEvidence>;
  authorize: (review: ChangeReview, context: ChangeContext) => Promise<void>;
  send: (plan: ChangePlan, step: Step, binding: Binding, context: ChangeContext, beforeSend: () => Promise<void>, progress: StoredChange) => Promise<StepOutcome>;
  verify: (plan: ChangePlan, step: Step, receipt: StepReceipt, binding: Binding, context: ChangeContext) => Promise<boolean | { updated: string }>;
}

function permissionWait(pending: Promise<void>, signal: AbortSignal, validate: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); complete();
    };
    const abort = () => finish(() => reject(signal.reason));
    const check = async () => {
      try { await validate(); }
      catch (error) { finish(() => reject(error)); return; }
      if (!settled) timer = setTimeout(() => { void check(); }, 1000);
    };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(() => finish(() => resolve()), (error) => finish(() => reject(error)));
    if (signal.aborted) abort();
    else timer = setTimeout(() => { void check(); }, 1000);
  });
}

export class ChangeApplication<Binding> {
  constructor(private readonly ports: ChangePorts<Binding>, private readonly options: StoreOptions & { data: string }) {}

  async prepare(input: ChangePlan, context: ChangeContext): Promise<StoredChange> {
    return this.prepareGenerated(async () => input, context);
  }

  async prepareGenerated(build: (store: ChangeStore, context: ChangeContext) => Promise<ChangePlan>, context: ChangeContext): Promise<StoredChange> {
    return withChangeStore(async (store) => {
      const input = await build(store, context);
      try {
        const plan = validatePlan(input);
        await this.validate(plan, context);
        changeReview(plan);
        await this.context(plan, context);
        const saved = await store.prepare(plan);
        metrics.increment("proposals.prepared", { account: plan.account });
        return saved;
      } catch (error) {
        try { store.discardUnassociated(input.files); }
        catch { console.error(JSON.stringify({ operation: "prepare-cleanup", code: "STAGING_RETAINED" })); }
        throw error;
      }
    }, { ...this.options, signal: context.signal });
  }

  private async context(plan: ChangePlan, context: ChangeContext): Promise<void> {
    cancellation(context.signal);
    const current = await context.resolve();
    cancellation(context.signal);
    if (context.sessionID !== plan.sessionID || current.sessionID !== plan.sessionID || current.locationID !== plan.locationID) {
      throw new IssueKeeperError("PROPOSAL_INVALID", "La propuesta pertenece a otra sesión o ubicación.");
    }
    context.onAccount?.(plan.account);
  }
  private async validate(plan: ChangePlan, context: ChangeContext, requireFreshness = true, progress?: StoredChange): Promise<ChangeValidation<Binding>> {
    await this.context(plan, context);
    const expectedHash = planHash(plan);
    const current = await this.ports.validate(structuredClone(plan), context, requireFreshness ? "apply" : "verify", progress ? structuredClone(progress) : undefined);
    cancellation(context.signal);
    if (planHash(plan) !== expectedHash || current.account !== plan.account || current.site !== plan.site || current.credentialIdentity !== plan.credentialIdentity
      || current.issueId !== plan.issueId || current.issueKey !== plan.issueKey || current.projectKey !== plan.projectKey
      || current.policyFingerprint !== plan.policyFingerprint || requireFreshness && Date.parse(current.updated) !== Date.parse(plan.expectedUpdated)) {
      metrics.increment("proposals.conflict", { account: plan.account });
      throw new IssueKeeperError("CONFLICT", "Cambió el contexto, identidad, política o ticket de la propuesta; no se enviará otro paso.");
    }
    await this.context(plan, context);
    return current;
  }
  private stop(store: ChangeStore, proposalId: string): void {
    const { execution } = store.get(proposalId);
    if (execution.state !== "applying") return;
    const uncertain = execution.steps.find((step) => step.state === "sending");
    const confirmed = execution.steps.some((step) => step.state === "confirmed");
    store.stop(proposalId, execution.revision, uncertain?.id, uncertain || confirmed ? "unknown" : "failed");
  }

  async apply(proposalId: string, context: ChangeContext): Promise<StoredChange> {
    return withChangeStore(async (store) => {
      const saved = store.get(proposalId);
      await this.context(saved.plan, context);
      const resumable = saved.execution.state === "unknown" && Object.keys(saved.receipts).length > 0 && saved.execution.steps.some((step) => step.state === "pending") && saved.execution.steps.every((step) => step.state === "pending" || step.state === "confirmed" && saved.receipts[step.id]?.verifiedAt);
      if (saved.execution.state !== "prepared" && !resumable) return saved;
      const plan = saved.plan;
      const review = changeReview(plan);
      const recorded = store.hasReviewed(proposalId, review.reviewHash) ? { payloadHash: review.payloadHash, reviewHash: review.reviewHash, complete: true } : undefined;
      assertReviewed(review, await this.ports.present(review, context, recorded));
      await this.context(plan, context);
      if (resumable) store.resume(proposalId, saved.execution.revision);
      else store.claim(proposalId, saved.execution.revision);
      try {
        await this.validate(plan, context, true, store.get(proposalId));
        await permissionWait(this.ports.authorize(review, context), context.signal, async () => {
          await this.context(plan, context);
          if ((this.options.now?.() ?? new Date()).getTime() >= Date.parse(plan.expiresAt)) throw new StateError("EXPIRED");
        });
        for (const step of plan.steps) {
          if (store.get(proposalId).receipts[step.id]?.verifiedAt) continue;
          const validation = await this.validate(plan, context, true, store.get(proposalId));
          let journaled = false;
          const outcome = await this.ports.send(structuredClone(plan), structuredClone(step), validation.binding, context, async () => {
            if (journaled) throw new StateError("CONFLICT");
            await this.validate(plan, context, true, store.get(proposalId));
            const current = store.get(proposalId);
            store.sending(proposalId, current.execution.revision, step.id);
            journaled = true;
          }, store.get(proposalId));
          if (!journaled) throw new StateError("CONFLICT");
          let current = store.get(proposalId);
          if (outcome.outcome !== "confirmed") {
            if (outcome.outcome === "rejected") metrics.increment("proposals.rejected", { account: plan.account });
            else metrics.increment("proposals.uncertain", { account: plan.account });
            store.stop(proposalId, current.execution.revision, step.id, outcome.outcome === "rejected" ? "failed" : "unknown", undefined, outcome.outcome === "rejected" ? outcome.status : undefined);
            cancellation(context.signal);
            return store.get(proposalId);
          }
          current = store.confirm(proposalId, current.execution.revision, step.id, outcome.receipt);
          await this.context(plan, context);
          const verified = await this.ports.verify(structuredClone(plan), structuredClone(step), structuredClone(current.receipts[step.id]!), validation.binding, context);
          await this.context(plan, context);
          if (!verified) {
            this.stop(store, proposalId);
            if (store.get(proposalId).execution.state === "unknown") metrics.increment("proposals.uncertain", { account: plan.account });
            return store.get(proposalId);
          }
          store.verified(proposalId, current.execution.revision, step.id, undefined, typeof verified === "object" ? verified.updated : undefined);
        }
        await this.context(plan, context);
        const finished = store.get(proposalId);
        if (finished.execution.state === "applied") metrics.increment("proposals.applied", { account: plan.account });
        return finished;
      } catch (error) {
        try { this.stop(store, proposalId); }
        finally { cancellation(context.signal); }
        if (error instanceof IssueKeeperError && store.get(proposalId).execution.state === "unknown") {
          metrics.increment("proposals.uncertain", { account: plan.account });
          throw new IssueKeeperError("WRITE_OUTCOME_UNKNOWN", "Se conserva el progreso confirmado o incierto. Consulte status/verify; no repita la mutación.");
        }
        throw error;
      }
    }, { ...this.options, signal: context.signal });
  }

  async verifyConfirmed(proposalId: string, context: ChangeContext): Promise<StoredChange> {
    return withChangeStore(async (store) => {
      let saved = store.get(proposalId);
      await this.context(saved.plan, context);
      if (saved.execution.state === "applied") return saved;
      for (const step of saved.plan.steps) {
        const receipt = saved.receipts[step.id];
        if (!receipt || receipt.verifiedAt) continue;
        const validation = await this.validate(saved.plan, context, false, saved);
        const verified = await this.ports.verify(structuredClone(saved.plan), structuredClone(step), structuredClone(receipt), validation.binding, context);
        await this.context(saved.plan, context);
        if (verified) {
          saved = store.verified(proposalId, saved.execution.revision, step.id, undefined, typeof verified === "object" ? verified.updated : undefined);
          if (saved.execution.state === "applied") metrics.increment("proposals.applied", { account: saved.plan.account });
        }
      }
      return saved;
    }, { ...this.options, signal: context.signal });
  }
}
