import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  { ignores: [".next/**", "node_modules/**", "*.config.{js,mjs,ts}", "next.config.*"] },

  eslint.configs.recommended,
  tseslint.configs.recommended,
  prettierConfig,

  // ── Rules applied to all linted files ────────────────────────────────────
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // Always require braces: if (x) { y } not if (x) y
      curly: ["error", "all"],

      // Require explicit null checks: if (x != null) not if (x)
      // allowAny: true because (this as any) patterns in the engine are intentional
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        {
          allowString: false,
          allowNumber: false,
          allowNullableObject: false,
          allowNullableBoolean: false,
          allowNullableString: false,
          allowNullableNumber: false,
          allowAny: true,
        },
      ],

      // Warn rather than error — 'any' is a last resort but sometimes unavoidable
      "@typescript-eslint/no-explicit-any": "warn",

      // Allow _ prefix for intentionally unused params (e.g. _removed in callbacks)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // ── Sync-engine core: ban parent-directory imports ────────────────────────
  {
    files: ["lib/sync-engine/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../*"],
              message: "Core files must not use parent-directory imports.",
            },
          ],
        },
      ],
    },
  },

  // ── Sync-engine tests: require @sync-engine/* instead of ../core/* ────────
  {
    files: ["lib/sync-engine/__tests__/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../core", "../core/*"],
              message: "Use '@sync-engine/*' instead of '../core/*'.",
            },
          ],
        },
      ],
    },
  },
);
