import { defineConfig } from "vitest/config";

/**
 * Anvil-backed e2e test config — run via `pnpm test:e2e`, kept separate from
 * the default (fast, network-free) `vitest.config.ts` used by `pnpm test`.
 *
 * Mirrors packages/core/vitest.e2e.config.ts's conventions.
 *
 * See test/e2e/README.md for the anvil dependency and how to run these tests.
 */
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.test.ts"],
    // Two real anvil chains + real HTTP-server deploys need far more headroom
    // than the mocked-provider fast suite.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Each e2e file spawns its own anvil child process(es); forks keep that
    // isolated per test file and make teardown (killing the children) reliable.
    pool: "forks",
  },
});
