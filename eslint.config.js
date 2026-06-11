// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores — applied before any per-file config.
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "contracts/out/**",
      "contracts/cache/**",
      "contracts/lib/**",
    ],
  },
  // Base recommended rules for all JS/TS files.
  eslint.configs.recommended,
  // TypeScript-aware recommended rules for .ts/.tsx files.
  // NOT type-checked — no parserOptions.project set.
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [...tseslint.configs.recommended],
  },
);
