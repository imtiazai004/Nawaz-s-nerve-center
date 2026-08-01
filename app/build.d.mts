/**
 * Types for `build.mjs`.
 *
 * The build script is plain ESM rather than TypeScript so it can be run directly with
 * `node build.mjs` and needs no compile step of its own. Two e2e suites import it to build
 * the web client before serving it, so it needs a declaration.
 */

/** Build the web client into `web/dist`. Returns the output directory. */
export function buildWeb(): Promise<string>;
