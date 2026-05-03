/**
 * Back-compat shim — Task 40.
 *
 * The structured logging framework lives in `./logging/`. This module keeps
 * the legacy `import { logger } from "./lib/logger"` form working by
 * re-exporting the pino instance bound to the `app` channel.
 */
export { pinoInstance as logger } from "./logging";
export { getLogger } from "./logging";
