import { defineConfig } from "vitest/config";
import path from "path";
import swc from "unplugin-swc";

export default defineConfig({
  oxc: false,
  plugins: [
    swc.vite({
      jsc: {
        parser: {
          syntax: "typescript",
          decorators: true,
        },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
        target: "es2020",
      },
      module: { type: "es6" },
    }),
  ],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./__tests__/setup.ts"],
    include: ["./__tests__/**/*.test.ts"],
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      "@sync-engine": path.resolve(__dirname, "src/core"),
    },
  },
});
