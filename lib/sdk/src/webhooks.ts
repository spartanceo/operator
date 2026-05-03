/**
 * Re-export of the verify helper under a name that matches the public
 * docs ("webhooks" subpath). Keeping a separate file means consumers
 * can `import { verifyEventSignature } from "@omninity/sdk/webhooks"`.
 */
export { verifyEventSignature, WebhookSignatureError } from "./events";
export type { VerifiedEvent } from "./events";
