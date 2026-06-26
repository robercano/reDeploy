/**
 * load-deployment.ts
 *
 * Node-only thin wrapper around readDeployment from @redeploy/reader.
 *
 * This module MUST NOT be imported by any browser-side code (Inspector.tsx,
 * App.tsx, main.tsx, etc.) because @redeploy/reader uses Node.js `fs` which
 * is not available in the browser bundle.
 *
 * Usage: tests and server-side/Node tooling only.
 */

export { readDeployment } from "@redeploy/reader";
export type { ReadDeploymentOptions, DeploymentView } from "@redeploy/reader";
