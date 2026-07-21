import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // index.ts is a process entry-point (parses real argv, calls process.exit);
      // exclude it from coverage so the threshold applies only to testable
      // business logic. vitest.config.ts itself is excluded as a tooling
      // config file.
      exclude: ["src/index.ts", "dist/**", "vitest.config.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
