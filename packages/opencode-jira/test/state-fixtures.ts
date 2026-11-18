import type { ChangePlan } from "../src/core/proposals.js";

export const instant = "2026-11-17T10:00:00.000Z";
export function planFixture(overrides: Partial<ChangePlan> = {}): ChangePlan {
  return {
    version: 1, id: "proposal-1", sessionID: "synthetic-session", locationID: "a".repeat(64), account: "qa",
    site: "https://synthetic.invalid", credentialIdentity: "person:synthetic", issueId: "10001", issueKey: "SYN-1", projectKey: "SYN",
    kind: "fields", files: [], steps: [{ id: "step-1", kind: "mutation", fileRefs: [] }],
    expectedUpdated: instant, policyFingerprint: "b".repeat(64), payload: { fields: { summary: "Síntesis 😀" } }, summary: "Cambio sintético",
    createdAt: instant, expiresAt: "2026-11-17T10:10:00.000Z", ...overrides,
  };
}
