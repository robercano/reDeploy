import { configDefaults, defineConfig } from "vitest/config";

/**
 * Default (fast, network-free) unit/integration test config.
 *
 * Anvil-backed e2e specs under test/e2e/**\/*.e2e.test.ts are intentionally
 * excluded here — they require two real `anvil` processes and are run
 * separately via `pnpm test:e2e` (see vitest.e2e.config.ts and
 * test/e2e/README.md). Mirrors packages/core/vitest.config.ts's conventions.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/e2e/**"],
    coverage: {
      provider: "v8",
      // index.ts is a process entry-point (binds a port); exclude it from
      // coverage so the threshold applies only to testable business logic.
      // vitest.config.ts / vitest.e2e.config.ts are excluded as tooling
      // config files (vitest.e2e.config.ts has an extra ".e2e" segment so it
      // isn't caught by coverageConfigDefaults' own vitest.config.* pattern).
      // test/e2e/** is excluded too — those specs never run under this
      // (fast, network-free) config, so instrumenting them would only ever
      // report a spurious 0% and dilute the real coverage numbers.
      exclude: ["src/index.ts", "dist/**", "vitest.config.ts", "vitest.e2e.config.ts", "test/e2e/**"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
