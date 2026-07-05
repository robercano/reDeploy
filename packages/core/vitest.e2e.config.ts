import { defineConfig } from "vitest/config";

/**
 * Anvil-backed e2e test config — run via `pnpm test:e2e`, kept separate from
 * the default (fast, network-free) `vitest.config.ts` used by `pnpm test`.
 *
 * See test/e2e/README.md for the anvil dependency and how to run these tests.
 */
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.test.ts"],
    // Anvil startup + real Ignition deploys against a live chain need far more
    // headroom than the mocked-provider unit suite.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Each e2e file spawns its own anvil child process; forks keep that
    // isolated per test file and make teardown (killing the child) reliable.
    pool: "forks",
  },
});
