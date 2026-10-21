/**
 * Root entrypoint for the opencode-swarm-lite plugin.
 *
 * OpenCode resolves a plugin DIRECTORY to `<dir>/server` or `<dir>/index`
 * (packages/plugin/src/host.ts in the OpenCode repo). It does not consult this
 * package's `exports` map for local directories, so without this file the
 * documented install
 *
 *   "plugins": [{ "package": "file:///path/to/opencode-swarm-lite" }]
 *
 * resolves to nothing, is dropped without an error, and the `options` block
 * never reaches the plugin. This file is that entrypoint.
 *
 * The implementation stays in src/index.ts so that `exports` keeps pointing at
 * the real module for registry installs.
 */
export { default, DispatchRateLimiter, decodeWatermark } from "./src/index.js"
export type { RateLimitOptions } from "./src/index.js"
