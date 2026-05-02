/**
 * Server entrypoint.
 *
 * Binds to the host returned by `bindHost()` — `127.0.0.1` by default per
 * Standard 12. The Replit preview proxy reaches the artifact via loopback
 * inside the same container, so `127.0.0.1` is correct in dev and prod.
 */
import app from "./app";
import { logger } from "./lib/logger";
import { bindHost } from "./lib/security";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const host = bindHost();

app.listen(port, host, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ host, port }, "Server listening");
});
