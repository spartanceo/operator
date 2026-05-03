/**
 * `@omninity/sdk-cli` — programmatic entry-point for the `op` command.
 *
 * Most users call the binary (`pnpm --filter @omninity/sdk-cli op …`),
 * but the CLI logic is also exported so other tooling (scripted
 * deploys, integration tests) can run a command without spawning a
 * subprocess.
 */
export { run } from "./cli";
