#!/usr/bin/env node
/**
 * Tiny shim — delegates to `cli.ts` so the entry script stays empty
 * enough to compile cleanly even before workspace deps are linked.
 */
import { run } from "./cli";

void run(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("op: fatal", (err as Error).message);
    process.exit(1);
  },
);
