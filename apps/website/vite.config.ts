import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Static marketing site: no backend, no proxy, no server-only deps to
// externalize (unlike apps/studio, which imports @redeploy/core transitively).
// Dev/preview ports are pinned to 5180 (strictPort) so `pnpm -F @redeploy/website dev`
// never collides with the studio, which defaults to 5173.
export default defineConfig({
  plugins: [react()],

  // Relative asset paths so the static build works unmodified when served
  // from a custom domain root on GitHub Pages (see public/CNAME).
  base: "./",

  server: { port: 5180, strictPort: true },
  preview: { port: 5180, strictPort: true },

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
        // Type-only declaration files (no runtime code to cover)
        "**/*.d.ts",
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
