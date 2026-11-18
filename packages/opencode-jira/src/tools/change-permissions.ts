import type { Plugin } from "@opencode/plugin";
import { assertReviewed, type ChangeReview, type ReviewEvidence } from "../core/review.js";
import type { ChangeContext } from "../state/application.js";
import { cancellation, IssueKeeperError } from "../errors.js";

type Context = Parameters<Plugin.Plugin["setup"]>[0];
type Editor = Parameters<Parameters<Context["tool"]["transform"]>[0]>[0];
type Execution = Parameters<Parameters<Editor["add"]>[0]["execute"]>[1];

export function nativeChangePermissions(ctx: Context, execution: Execution) {
  return {
    present: async (review: ChangeReview, _context: ChangeContext, recorded?: ReviewEvidence): Promise<ReviewEvidence> => {
      cancellation(execution.signal);
      if (!recorded) throw new IssueKeeperError("FORBIDDEN", `Falta revisión íntegra. Ejecute en su terminal: issuekeeper-jira review --global --proposal ${review.proposalId}`);
      assertReviewed(review, recorded);
      return recorded;
    },
    authorize: async (review: ChangeReview): Promise<void> => {
      cancellation(execution.signal);
      await ctx.permission.assert({ sessionID: execution.sessionID, agent: execution.agent,
        source: { type: "tool", messageID: execution.messageID, id: execution.id },
        action: "jira.write", resources: [review.resource], save: [review.resource],
        metadata: { proposalId: review.proposalId, payloadHash: review.payloadHash, reviewHash: review.reviewHash },
      });
      cancellation(execution.signal);
    },
  };
}
