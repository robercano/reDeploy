import { configDefaults, coverageConfigDefaults, defineConfig } from "vitest/config";

/**
 * Default (fast, network-free) unit test config.
 *
 * Anvil-backed e2e specs under test/e2e/**\/*.e2e.test.ts are intentionally
 * excluded here — they require a real `anvil` process and are run separately
 * via `pnpm test:e2e` (see vitest.e2e.config.ts and test/e2e/README.md).
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/e2e/**"],
    coverage: {
      // vitest.config.ts itself is already excluded by coverageConfigDefaults
      // (matches the **/{...,vitest,...}.config.* pattern). vitest.e2e.config.ts
      // does NOT match that pattern (extra ".e2e" segment) and is a tooling
      // config file, not testable business logic — exclude it explicitly so it
      // doesn't dilute the unit-suite coverage numbers with an always-0% file.
      exclude: [...coverageConfigDefaults.exclude, "vitest.e2e.config.ts"],
    },
  },
});
