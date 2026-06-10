#!/usr/bin/env node
/**
 * The installed binary (package.json "bin" target). Runs main()
 * UNCONDITIONALLY — there is deliberately no "am I the entry module?" guard
 * here, because such guards break under npm's bin symlinks and fail silently.
 * Any startup failure must print to stderr and exit non-zero; exiting 0 with
 * no output is a bug.
 */
import { main } from './cli.js';

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(
      `arks: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  },
);
