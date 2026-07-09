import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Static marketing site: no backend, no proxy, no server-only deps to
// externalize (unlike apps/studio, which imports @redeploy/core transitively).
export default defineConfig({
  plugins: [react()],

  build: {
    outDir: "dist",
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
      ],
    },
  },
});
