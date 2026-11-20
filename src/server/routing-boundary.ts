import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The ordinary Routing request's idempotency grammar and raw-text fingerprint
 * are centralized here so the service and evidence orchestration cannot use a
 * second representation.
 */
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[\w-]+$/);

export interface RoutingRequestFingerprintInput {
  method: string;
  pathname: string;
  text: string;
}

/**
 * Compatibility contract: this is SHA-256 over the literal method, pathname,
 * and un-normalized UTF-8 request text. JSON is deliberately not reserialized.
 */
export function createRoutingRequestFingerprint({
  method,
  pathname,
  text,
}: RoutingRequestFingerprintInput): string {
  return createHash("sha256")
    .update(`${method}:${pathname}:${text}`)
    .digest("hex");
}

/**
 * Structural Routing command boundary. The service validates this before it
 * delegates eligible Routing requests to the outside-transaction orchestration.
 */
export const routingTransitionSchema = z
  .object({
    status: z.literal("Routing"),
    route: z.enum(["direct", "split", "multi"]),
    quoteId: z.uuid(),
  })
  .strict();

export type RoutingTransitionRequest = z.infer<typeof routingTransitionSchema>;
