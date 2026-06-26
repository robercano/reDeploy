import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  // Production build: mark Node-only transitive deps as external so Rollup
  // doesn't try to bundle native binaries (.node files) or fs/path builtins
  // that @nomicfoundation/ignition-core (pulled in by @redeploy/core) requires.
  // In production the studio would be served as a static SPA; the deploy/compile
  // machinery is server-side only. Only validateSpec / validateConfig (pure JS)
  // are used in the browser — Rollup can tree-shake everything else once the
  // following node_modules are externalized.
  build: {
    rollupOptions: {
      external: [
        // Hardhat Ignition — Node-only, has native .node binaries
        /^@nomicfoundation\//,
        // @redeploy/reader — Node-only (uses fs); only its types are used in browser code
        "@redeploy/reader",
        // Other Node-only packages pulled in transitively
        /^hardhat/,
        /^ethers/,
        "fs",
        "fs-extra",
        "path",
        "child_process",
        "util",
        "os",
        "node:fs",
        "node:path",
        "node:util",
        "node:os",
        "node:child_process",
      ],
    },
  },

  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 80,
      },
      exclude: [
        // Bootstrap / entry-point files (no logic)
        "src/main.tsx",
        // Config files
        "vite.config.ts",
        "**/*.config.*",
        // Static assets
        "index.html",
        // Test infrastructure
        "test/setup.ts",
        "test/**",
        // Build outputs & deps
        "dist/**",
        "node_modules/**",
        // Type-only file: no runtime code, always 0% coverage
        "src/spec/types.ts",
        // Inspector type-only file
        "src/inspector/types.ts",
        // Data-constant only: no logic
        "src/inspector/sample-view.ts",
        // Trivial Node-only wrapper: no logic
        "src/inspector/load-deployment.ts",
      ],
    },
  },
});
