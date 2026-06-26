/**
 * sample-view.ts
 *
 * A small in-memory DeploymentView constant for the browser default.
 * Used by App.tsx in inspector mode so the Inspector renders something
 * meaningful without reading from disk.
 *
 * This module is a data constant only — no logic, excluded from coverage.
 */

import type { DeploymentView } from "@redeploy/reader";

/** A sample deployment view with three contracts and two config steps. */
export const SAMPLE_DEPLOYMENT_VIEW: DeploymentView = {
  contracts: [
    {
      id: "registry",
      contractName: "Registry",
      address: "0x1111111111111111111111111111111111111111",
      args: [],
      links: {
        dependencies: [],
        libraries: {},
      },
    },
    {
      id: "token",
      contractName: "ERC20Token",
      address: "0x2222222222222222222222222222222222222222",
      args: ["My Token", { $bigint: "1000000000000000000" }],
      links: {
        dependencies: [],
        libraries: {},
      },
    },
    {
      id: "vault",
      contractName: "Vault",
      address: null,
      args: [],
      links: {
        dependencies: ["token", "registry"],
        libraries: {},
      },
    },
  ],
  configSteps: [
    {
      id: "setFee",
      kind: "functionCall",
      completed: true,
      completedAt: "2024-01-01T00:00:00.000Z",
    },
    {
      id: "setToken",
      kind: "functionCall",
      completed: false,
      completedAt: null,
    },
  ],
  warnings: [],
};
