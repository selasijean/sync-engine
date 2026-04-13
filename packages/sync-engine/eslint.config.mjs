import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";
import { defineConfig } from "eslint/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(
  { ignores: ["node_modules/**", "*.config.{js,mjs,ts}"] },

  eslint.configs.recommended,
  tseslint.configs.recommended,
  prettierConfig,

  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      curly: ["error", "all"],

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

      "@typescript-eslint/no-explicit-any": "warn",

      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Core files must not import from parent directories
  {
    files: ["src/core/**/*.ts"],
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

  // Tests must use @sync-engine/* aliases instead of relative core imports
  {
    files: ["__tests__/**/*.ts"],
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
