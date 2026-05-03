/**
 * Webhook signature verification helper. Sidecar HTTP servers receiving
 * Operator events can call `verifyEventSignature(secret, headers, body)`
 * to confirm the payload was signed by the same secret stored on the
 * subscription. Constant-time compare avoids timing leaks.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifiedEvent<T = unknown> {
  id: string;
  type: string;
  timestamp: string;
  tenantId: string;
  workspaceId: string;
  data: T;
}

export class WebhookSignatureError extends Error {
  override readonly name = "WebhookSignatureError";
}

/**
 * Verify the `X-Omninity-Signature` header against the raw request
 * body. Returns the parsed event on success, throws otherwise.
 */
export function verifyEventSignature<T = unknown>(
  secret: string,
  signatureHeader: string | undefined | null,
  rawBody: string,
): VerifiedEvent<T> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    throw new WebhookSignatureError("Missing or malformed signature header");
  }
  const provided = signatureHeader.slice("sha256=".length);
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  ) {
    throw new WebhookSignatureError("Signature mismatch");
  }
  try {
    return JSON.parse(rawBody) as VerifiedEvent<T>;
  } catch {
    throw new WebhookSignatureError("Body is not valid JSON");
  }
}
