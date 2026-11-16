import { z } from "zod";

const shared = {
  account: z.string().optional(),
  warnings: z.array(z.string()),
  meta: z.strictObject({ requestId: z.uuid(), truncated: z.boolean(), untrustedContent: z.literal(true) }),
};
export const ResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ...shared, ok: z.literal(true), data: z.unknown() }),
  z.strictObject({
    ...shared, ok: z.literal(false),
    error: z.strictObject({
      code: z.string(), message: z.string(), retryable: z.boolean(),
      retryAfterSeconds: z.number().optional(), fieldErrors: z.record(z.string(), z.string()).optional(),
    }),
  }),
]);
