import type { SyntheticPlan } from "./persistence.js";

export const now = "2026-11-17T10:00:00.000Z";
export function syntheticPlan(overrides: Partial<SyntheticPlan> = {}): SyntheticPlan {
  return {
    version: 1, id: "proposal-1", sessionID: "synthetic-session", locationID: "a".repeat(64),
    account: "synthetic-account", site: "https://synthetic.invalid", credentialIdentity: "synthetic-person",
    issueId: "10001", issueKey: "SYN-1", policyFingerprint: "b".repeat(64), expectedUpdated: now,
    createdAt: now, expiresAt: "2026-11-17T10:10:00.000Z",
    change: { audience: "internal", source: "Texto sintético", format: "plain", representation: { body: "Texto sintético" } },
    steps: [{ id: "step-1", kind: "mutation", fileRefs: [] }],
    ...overrides,
  };
}
